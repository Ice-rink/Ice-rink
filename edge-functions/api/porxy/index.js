export async function onRequest({ request, env }) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ========== 健康检查（可选） ==========
    if (path === '/health') {
        return new Response(JSON.stringify({ status: 'ok', service: 'dynamic-proxy' }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // ========== 动态代理核心 ==========
    // 用法：https://你的域名/proxy/github.com/user/repo
    if (!path.startsWith('/proxy/')) {
        return new Response(JSON.stringify({
            error: '请使用 /proxy/域名/路径 格式访问',
            example: 'https://你的域名/proxy/github.com/'
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 提取目标域名和路径
    const rest = path.slice(7); // 去掉 '/proxy/'
    const firstSlash = rest.indexOf('/');

    if (firstSlash === -1) {
        return new Response(JSON.stringify({
            error: '缺少目标路径，请使用 /proxy/域名/路径 格式'
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const targetHost = rest.substring(0, firstSlash);
    const targetPath = rest.substring(firstSlash);

    // 构造目标 URL（保留查询参数）
    const targetUrl = `https://${targetHost}${targetPath}${url.search}`;

    // ========== 安全白名单 ==========
    const ALLOWED_HOSTS = [
        'github.com',
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
            error: `域名 ${targetHost} 不在白名单中`,
            allowed: ALLOWED_HOSTS
        }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // ========== 构造转发请求 ==========
    const newRequest = new Request(targetUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body
    });

    // 修正 Host 头（关键！）
    newRequest.headers.set('Host', targetHost);

    // 清理可能泄露源站信息的头
    newRequest.headers.delete('Referer');
    newRequest.headers.delete('Origin');
    // 注意：不要删除 'Authorization'，如果代理需要鉴权

    // ========== 发起转发 ==========
    try {
        const response = await fetch(newRequest);

        // 如果是 HTML 页面，添加提示头（可选）
        const newResponse = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });

        // 添加代理标识（方便调试）
        newResponse.headers.set('X-Proxy-By', 'EdgeOne-Dynamic-Proxy');

        return newResponse;
    } catch (error) {
        return new Response(JSON.stringify({
            error: '代理失败',
            message: error.message,
            target: targetUrl
        }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}