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

        // 读取响应体
        let responseBody = await response.text();

        // 6. 🔧 HTML 内容重写（仅对 HTML 生效）
        if (isHtml) {
            // 获取当前代理的基础 URL
            const baseProxyUrl = `${targetProtocol}//${url.host}${url.pathname}`;

            // 构建代理链接的函数
            const proxyUrl = (href) => {
                if (!href) return href;
                // 跳过 javascript:、mailto:、tel:、#、data: 等协议
                if (/^(javascript|mailto|tel|data|blob|ws|wss):/.test(href)) return href;
                // 如果已经是代理链接，跳过
                if (href.startsWith(baseProxyUrl)) return href;
                // 如果是绝对路径（以 / 开头）
                if (href.startsWith('/')) {
                    return `${baseProxyUrl}?url=${targetHost}${href}`;
                }
                // 如果是完整 URL
                if (href.startsWith('http://') || href.startsWith('https://')) {
                    // 如果是同域名的完整 URL，转为代理
                    const hrefParsed = new URL(href);
                    if (hrefParsed.hostname === targetHost) {
                        return `${baseProxyUrl}?url=${hrefParsed.hostname}${hrefParsed.pathname}${hrefParsed.search}`;
                    }
                    // 不同域名，保留原样或也代理（根据需求）
                    return href;
                }
                // 如果是相对路径（不以 / 开头）
                if (!href.startsWith('/') && !href.startsWith('http')) {
                    return `${baseProxyUrl}?url=${targetHost}/${href}`;
                }
                return href;
            };

            // 重写 <a href>
            responseBody = responseBody.replace(
                /<a\s+([^>]*?)href=["']([^"']*)["']/gi,
                (match, attrs, href) => {
                    const newHref = proxyUrl(href);
                    return `<a ${attrs}href="${newHref}"`;
                }
            );

            // 重写 <link href> (CSS 等)
            responseBody = responseBody.replace(
                /<link\s+([^>]*?)href=["']([^"']*)["']/gi,
                (match, attrs, href) => {
                    const newHref = proxyUrl(href);
                    return `<link ${attrs}href="${newHref}"`;
                }
            );

            // 重写 <script src>
            responseBody = responseBody.replace(
                /<script\s+([^>]*?)src=["']([^"']*)["']/gi,
                (match, attrs, src) => {
                    const newSrc = proxyUrl(src);
                    return `<script ${attrs}src="${newSrc}"`;
                }
            );

            // 重写 <img src>
            responseBody = responseBody.replace(
                /<img\s+([^>]*?)src=["']([^"']*)["']/gi,
                (match, attrs, src) => {
                    const newSrc = proxyUrl(src);
                    return `<img ${attrs}src="${newSrc}"`;
                }
            );

            // 重写 CSS 中的 url()
            responseBody = responseBody.replace(
                /url\(["']?([^"')]*)["']?\)/gi,
                (match, cssUrl) => {
                    const newUrl = proxyUrl(cssUrl.trim());
                    return `url("${newUrl}")`;
                }
            );

            // 重写 <form action>
            responseBody = responseBody.replace(
                /<form\s+([^>]*?)action=["']([^"']*)["']/gi,
                (match, attrs, action) => {
                    const newAction = proxyUrl(action);
                    return `<form ${attrs}action="${newAction}"`;
                }
            );

            // 重写 <meta refresh> 和 <meta og:url>
            responseBody = responseBody.replace(
                /<meta\s+([^>]*?)content=["']([^"']*)["']/gi,
                (match, attrs, content) => {
                    // 检查是否是 URL 类型的 meta
                    if (/url|URL|refresh|redirect/i.test(attrs)) {
                        const newContent = proxyUrl(content);
                        return `<meta ${attrs}content="${newContent}"`;
                    }
                    return match;
                }
            );
        }

        // 7. 构造响应
        const newResponse = new Response(responseBody, {
            status: response.status,
            statusText: response.statusText
        });

        // 复制原响应头（除压缩相关）
        for (const [key, value] of response.headers) {
            if (!['content-encoding', 'content-length'].includes(key.toLowerCase())) {
                newResponse.headers.set(key, value);
            }
        }

        // 添加 CORS 头
        newResponse.headers.set('Access-Control-Allow-Origin', '*');
        newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        // 确保 HTML 内容类型正确
        if (isHtml) {
            newResponse.headers.set('Content-Type', 'text/html; charset=utf-8');
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