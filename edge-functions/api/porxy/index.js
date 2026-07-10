export async function onRequest({ request, env }) {
    const url = new URL(request.url);

    // 1. 从查询参数获取目标 URL
    const targetUrlParam = url.searchParams.get('url');
    if (!targetUrlParam) {
        return new Response(JSON.stringify({
            error: '缺少 url 参数，请使用 ?url=https://github.com/xxx'
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 2. 补全协议（如果没写）
    let targetUrl = targetUrlParam;
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = 'https://' + targetUrl;
    }

    // 3. 解析目标 URL，提取域名做白名单校验
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

    // 4. 白名单（按需增删）
    const ALLOWED_HOSTS = [
        'github.com',
        'www.github.com',
        'raw.githubusercontent.com',
        'gist.github.com',
        'generativelanguage.googleapis.com',
        'api.openai.com',
        'huggingface.co'
    ];

    const isAllowed = ALLOWED_HOSTS.some(allowed =>
        targetHost === allowed || targetHost.endsWith('.' + allowed)
    );

    if (!isAllowed) {
        return new Response(JSON.stringify({
            error: `域名 ${targetHost} 不在白名单中`
        }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 5. 构造转发请求（保留原请求的 method、headers、body）
    const newRequest = new Request(targetUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body
    });

    // 修正 Host 头
    newRequest.headers.set('Host', targetHost);

    // 删除可能泄露源站信息的头
    newRequest.headers.delete('Referer');
    newRequest.headers.delete('Origin');
    newRequest.headers.delete('X-Forwarded-For');

    // 6. 发起转发
    try {
        const response = await fetch(newRequest);

        // 如果是 HTML 页面，返回时需要处理 CORS 问题
        const contentType = response.headers.get('Content-Type') || '';
        if (contentType.includes('text/html')) {
            // 克隆响应以便修改
            const clonedResponse = new Response(response.body, response);
            // 添加 CORS 头，让浏览器允许跨域
            clonedResponse.headers.set('Access-Control-Allow-Origin', '*');
            return clonedResponse;
        }

        return response;
    } catch (error) {
        return new Response(JSON.stringify({
            error: '代理失败: ' + error.message
        }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}