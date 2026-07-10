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

    // 4. 🌟 动态白名单（允许代理任意 HTTPS 外部资源）
    // 改为宽松模式：只要是 HTTPS 且非内网 IP 就允许
    const isAllowed = (host) => {
        // 禁止内网地址
        const internalIPs = ['127.0.0.1', 'localhost', '::1', '10.', '172.16.', '192.168.'];
        for (const ip of internalIPs) {
            if (host.startsWith(ip)) return false;
        }
        // 允许所有公网 HTTPS
        return true;
    };

    if (!isAllowed(targetHost)) {
        return new Response(JSON.stringify({
            error: `域名 ${targetHost} 不允许代理（内网地址）`
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

        // 6. 🔧 HTML 内容重写（修复双斜杠 + 外部资源代理）
        if (isHtml) {
            const baseProxyUrl = `${targetProtocol}//${url.host}${url.pathname}`;

            // 🔧 修复：正确拼接 URL，避免双斜杠
            const proxyUrl = (href) => {
                if (!href) return href;
                // 跳过特殊协议
                if (/^(javascript|mailto|tel|data|blob|ws|wss):/.test(href)) return href;
                // 如果已经是代理链接，跳过
                if (href.startsWith(baseProxyUrl)) return href;

                // 处理完整 URL（外部资源）
                if (href.startsWith('http://') || href.startsWith('https://')) {
                    // 🔧 关键修复：直接代理外部资源，不拼接 targetHost
                    return `${baseProxyUrl}?url=${href}`;
                }

                // 处理绝对路径（以 / 开头）
                if (href.startsWith('/')) {
                    // 🔧 修复：去掉多余的 /，直接拼接
                    return `${baseProxyUrl}?url=${targetHost}${href}`;
                }

                // 处理相对路径（不以 / 开头）
                if (!href.startsWith('/') && !href.startsWith('http')) {
                    return `${baseProxyUrl}?url=${targetHost}/${href}`;
                }

                return href;
            };

            // 重写所有资源链接
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

            // 重写 CSS url()
            responseBody = responseBody.replace(
                /url\(["']?([^"')]*)["']?\)/gi,
                (match, cssUrl) => {
                    const newUrl = proxyUrl(cssUrl.trim());
                    return `url("${newUrl}")`;
                }
            );

            // 重写 meta
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

        // 7. CSS 内容重写（处理 CSS 中的 url()）
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

        // 添加 CORS 头
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