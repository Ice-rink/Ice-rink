export async function onRequest({ request, env }) {
    const url = new URL(request.url);

    // 1. 获取目标 URL
    const targetUrlParam = url.searchParams.get('url');
    if (!targetUrlParam) {
        return new Response(JSON.stringify({
            error: '缺少 url 参数，请使用 ?url=https://github.com/xxx'
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 2. 补全协议
    let targetUrl = targetUrlParam;
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = 'https://' + targetUrl;
    }

    // 3. 解析目标 URL
    let targetHost, targetProtocol;
    try {
        const parsed = new URL(targetUrl);
        targetHost = parsed.hostname;
        targetProtocol = parsed.protocol;
    } catch (e) {
        return new Response(JSON.stringify({ error: '无效的 URL 格式' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 4. 🚀 去掉白名单，只禁止内网地址（安全防护）
    const isBlocked = (host) => {
        // 禁止内网地址，防止 SSRF 攻击
        const blockedPatterns = [
            '127.0.0.1', 'localhost', '::1',
            '10.', '172.16.', '172.17.', '172.18.', '172.19.',
            '172.20.', '172.21.', '172.22.', '172.23.',
            '172.24.', '172.25.', '172.26.', '172.27.',
            '172.28.', '172.29.', '172.30.', '172.31.',
            '192.168.', '169.254.'
        ];
        for (const pattern of blockedPatterns) {
            if (host.startsWith(pattern)) return true;
        }
        return false;
    };

    if (isBlocked(targetHost)) {
        return new Response(JSON.stringify({
            error: `禁止访问内网地址: ${targetHost}`
        }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 5. 转发请求
    const newRequest = new Request(targetUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body
    });

    newRequest.headers.set('Host', targetHost);
    newRequest.headers.delete('Accept-Encoding');
    newRequest.headers.delete('Content-Encoding');
    newRequest.headers.delete('Referer');
    newRequest.headers.delete('Origin');
    newRequest.headers.delete('X-Forwarded-For');

    try {
        const response = await fetch(newRequest);
        const contentType = response.headers.get('Content-Type') || '';
        const isHtml = contentType.includes('text/html');
        const isCss = contentType.includes('text/css');
        const isJs = contentType.includes('javascript') || contentType.includes('ecmascript');

        // 读取响应体
        let responseBody = await response.text();

        // 6. HTML 内容重写
        if (isHtml) {
            const baseProxyUrl = `${targetProtocol}//${url.host}${url.pathname}`;

            const proxyUrl = (href) => {
                if (!href) return href;
                // 跳过特殊协议
                if (/^(javascript|mailto|tel|data|blob|ws|wss):/.test(href)) return href;
                // 如果已经是代理链接，跳过
                if (href.startsWith(baseProxyUrl)) return href;

                // 完整 URL（外部资源）
                if (href.startsWith('http://') || href.startsWith('https://')) {
                    return `${baseProxyUrl}?url=${href}`;
                }

                // 绝对路径
                if (href.startsWith('/')) {
                    return `${baseProxyUrl}?url=${targetHost}${href}`;
                }

                // 相对路径
                if (!href.startsWith('/') && !href.startsWith('http')) {
                    return `${baseProxyUrl}?url=${targetHost}/${href}`;
                }

                return href;
            };

            // 重写标签
            const rewriteTag = (html, tag, attr) => {
                const regex = new RegExp(`<${tag}\\s+([^>]*?)${attr}=["']([^"']*)["']`, 'gi');
                return html.replace(regex, (match, attrs, value) => {
                    const newValue = proxyUrl(value);
                    return `<${tag} ${attrs}${attr}="${newValue}"`;
                });
            };

            responseBody = rewriteTag(responseBody, 'a', 'href');
            responseBody = rewriteTag(responseBody, 'link', 'href');
            responseBody = rewriteTag(responseBody, 'script', 'src');
            responseBody = rewriteTag(responseBody, 'img', 'src');
            responseBody = rewriteTag(responseBody, 'form', 'action');

            // CSS url()
            responseBody = responseBody.replace(
                /url\(["']?([^"')]*)["']?\)/gi,
                (match, cssUrl) => {
                    const newUrl = proxyUrl(cssUrl.trim());
                    return `url("${newUrl}")`;
                }
            );

            // meta
            responseBody = responseBody.replace(
                /<meta\s+([^>]*?)content=["']([^"']*)["']/gi,
                (match, attrs, content) => {
                    if (/url|URL|refresh|redirect/i.test(attrs)) {
                        return `<meta ${attrs}content="${proxyUrl(content)}"`;
                    }
                    return match;
                }
            );
        }

        // 7. CSS 内容重写
        if (isCss) {
            const baseProxyUrl = `${targetProtocol}//${url.host}${url.pathname}`;
            const proxyUrl = (href) => {
                if (!href) return href;
                if (/^(javascript|mailto|tel|data|blob|ws|wss):/.test(href)) return href;
                if (href.startsWith('http://') || href.startsWith('https://')) {
                    return `${baseProxyUrl}?url=${href}`;
                }
                if (href.startsWith('/')) {
                    return `${baseProxyUrl}?url=${targetHost}${href}`;
                }
                if (!href.startsWith('/') && !href.startsWith('http')) {
                    return `${baseProxyUrl}?url=${targetHost}/${href}`;
                }
                return href;
            };

            responseBody = responseBody.replace(
                /url\(["']?([^"')]*)["']?\)/gi,
                (match, cssUrl) => {
                    const newUrl = proxyUrl(cssUrl.trim());
                    return `url("${newUrl}")`;
                }
            );
        }

        // 8. 构造响应
        const newResponse = new Response(responseBody, {
            status: response.status,
            statusText: response.statusText
        });

        // 复制原响应头
        for (const [key, value] of response.headers) {
            if (!['content-encoding', 'content-length', 'content-security-policy'].includes(key.toLowerCase())) {
                newResponse.headers.set(key, value);
            }
        }

        // CORS 头
        newResponse.headers.set('Access-Control-Allow-Origin', '*');
        newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (isHtml) {
            newResponse.headers.set('Content-Type', 'text/html; charset=utf-8');
        }
        if (isCss) {
            newResponse.headers.set('Content-Type', 'text/css; charset=utf-8');
        }

        return newResponse;

    } catch (error) {
        return new Response(JSON.stringify({
            error: '代理失败: ' + error.message
        }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}