import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { Readable } from "stream";

// Disable SSL certificate verification globally for external custom streaming feeds
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/**
 * Resolves a relative HLS path or URL context to a complete absolute URL,
 * merging query tokens (e.g. key, token, time) to preserve stream credentials.
 */
function resolveUrl(baseUrl: string, relativeUrl: string): string {
  try {
    const baseObj = new URL(baseUrl);
    const resolvedObj = new URL(relativeUrl, baseUrl);
    
    if (resolvedObj.hostname === baseObj.hostname) {
      // Merge query parameters from base URL to the resolved URL if they don't already exist
      baseObj.searchParams.forEach((value, key) => {
        if (!resolvedObj.searchParams.has(key)) {
          resolvedObj.searchParams.set(key, value);
        }
      });
    }
    return resolvedObj.href;
  } catch (err) {
    return relativeUrl;
  }
}

/**
 * Rewrites relative/absolute paths in the .m3u8 manifest files to route back through our secure proxy.
 * This guarantees that both sub-playlists (.m3u8) and video keyframes/segments (.ts, decryption keys)
 * are recursively fetched through the proxy, ensuring a 100% bypass of HTTPS mixed-content and CORS errors.
 * Prepending the absolute host URL resolves AVPlayer's native pathing bugs on mobile devices like iOS.
 */
function rewriteM3U8(content: string, baseUrl: string, requestHostUrl: string): string {
  // Normalize line endings to avoid \r parsing issues on different CDNs
  const lines = content.replace(/\r/g, '').split('\n');
  const proxyBase = `${requestHostUrl}/api/proxy?url=`;

  const rewrittenLines = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Line is an HLS informational or structural tag
    if (trimmed.startsWith('#')) {
      // Look for absolute/relative URIs embedded in tags (e.g., EXT-X-KEY decryption licenses or EXT-X-MAP segment links)
      return trimmed.replace(/(URI\s*=\s*["'])([^"']+)((["']\s*))/g, (match, prefix, uri, suffix) => {
        const absoluteUri = resolveUrl(baseUrl, uri);
        const proxiedUri = proxyBase + encodeURIComponent(absoluteUri);
        return `${prefix}${proxiedUri}${suffix}`;
      });
    }

    // Line is a direct file path or URL to a segment or sub-playlist
    const absoluteUrl = resolveUrl(baseUrl, trimmed);
    return proxyBase + encodeURIComponent(absoluteUrl);
  });

  return rewrittenLines.join('\n');
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Enable CORS helper headers for the entire express service
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // 1. Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({ status: "alive" });
  });

  // 2. High-performance Live Stream CORS, Referer & Mixed Content Proxy
  app.get("/api/proxy", async (req, res) => {
    const urlParam = req.query.url as string;
    if (!urlParam) {
      return res.status(400).send("Missing target 'url' parameter.");
    }

    try {
      const targetUrl = new URL(urlParam);

      // Construct dynamic bypass headers
      const requestHeaders: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      };

      // Auto-impersonate original stream hostname as the referer and origin
      // This completely bypasses tsports or asimxtech hotlinking checks
      requestHeaders['Referer'] = targetUrl.origin + '/';
      requestHeaders['Origin'] = targetUrl.origin;

      // Execute request
      const response = await fetch(urlParam, {
        headers: requestHeaders,
        method: 'GET'
      });

      if (!response.ok) {
        return res.status(response.status).send(`Stream fetch failed: ${response.statusText}`);
      }

      // Read remote content type
      const contentType = response.headers.get('content-type') || '';
      
      // Force correct player compatibility headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

      const isM3U8 = contentType.includes('mpegurl') || 
                     contentType.includes('mpegURL') || 
                     contentType.includes('application/x-mpegURL') || 
                     contentType.includes('audio/x-mpegurl') || 
                     urlParam.toLowerCase().includes('.m3u8');

      if (isM3U8) {
        // HLS playlist manifest: Parse and route sub-links
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        const originalText = await response.text();
        
        // Construct absolute proxy URL base for compatibility with native players (iOS Safari/AVPlayer)
        const host = String(req.headers['x-forwarded-host'] || req.get('host') || '');
        const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https' || (!host.includes('localhost') && !host.includes('127.0.0.1'));
        const protocol = isSecure ? 'https' : 'http';
        const requestHostUrl = `${protocol}://${host}`;
        
        const rewrittenManifest = rewriteM3U8(originalText, urlParam, requestHostUrl);
        return res.send(rewrittenManifest);
      } else {
        // Binary streaming segments (.ts files, etc.)
        if (contentType) {
          res.setHeader('Content-Type', contentType);
        }
        
        // Fetch as arrayBuffer to guarantee Node compatibility across all environments
        const arrayBuffer = await response.arrayBuffer();
        return res.send(Buffer.from(arrayBuffer));
      }
    } catch (err: any) {
      console.error("HLS Streaming Proxy Failure:", err);
      res.status(500).send(`Stream proxying failed: ${err.message}`);
    }
  });

  // 3. Vite development middleware / production static server mounting
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server launched and listening on http://localhost:${PORT}`);
  });
}

startServer();
