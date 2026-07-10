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
    let targetHost;
    try {
        const parsed = new URL(targetUrl);
        targetHost = parsed.hostname;
    } catch (e) {
        return new Response(JSON.stringify({ error: '无效的 URL 格式' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 5. 🔧 关键修复：正确转发请求
    const newRequest = new Request(targetUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body
    });

    // 修正 Host 头
    newRequest.headers.set('Host', targetHost);

    // ❌ 删除客户端发送的压缩相关头，让目标服务器返回原始内容
    newRequest.headers.delete('Accept-Encoding');
    newRequest.headers.delete('Content-Encoding');
    newRequest.headers.delete('Referer');
    newRequest.headers.delete('Origin');
    newRequest.headers.delete('X-Forwarded-For');

    try {
        // 6. 发起请求
        const response = await fetch(newRequest);

        // 7. 🔧 关键修复：获取响应内容并正确处理
        const contentType = response.headers.get('Content-Type') || '';
        const isHtml = contentType.includes('text/html');
        const isJson = contentType.includes('application/json');

        // 读取响应体（自动处理 gzip 解压）
        let responseBody;
        try {
            responseBody = await response.arrayBuffer();
        } catch (e) {
            // 如果读取失败，尝试 text
            responseBody = await response.text();
        }

        // 8. 构造新响应
        const newResponse = new Response(responseBody, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });

        // 9. 🔧 关键修复：删除压缩相关的响应头（避免浏览器解压失败）
        newResponse.headers.delete('Content-Encoding');
        newResponse.headers.delete('Content-Length'); // 长度会变化，让浏览器自动计算

        // 10. 添加 CORS 头
        newResponse.headers.set('Access-Control-Allow-Origin', '*');
        newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        // 如果是 HTML，额外处理
        if (isHtml) {
            // 确保 Content-Type 正确
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