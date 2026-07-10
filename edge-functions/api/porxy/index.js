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
    let targetHost, targetProtocol, targetPath;
    try {
        const parsed = new URL(targetUrl);
        targetHost = parsed.hostname;
        targetProtocol = parsed.protocol;
        targetPath = parsed.pathname;
    } catch (e) {
        return new Response(JSON.stringify({ error: '无效的 URL 格式' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 4. 禁止内网地址
    const isBlocked = (host) => {
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

        let responseBody = await response.text();

        // 6. 基础代理 URL 生成器
        const baseProxyUrl = `${targetProtocol}//${url.host}${url.pathname}`;

        // 🔧 核心：智能 URL 转换函数（处理所有相对地址）
        const proxyUrl = (href, basePath = targetPath) => {
            if (!href) return href;

            // 去除首尾空白
            href = href.trim();

            // 跳过特殊协议
            if (/^(javascript|mailto|tel|data|blob|ws|wss|about|chrome-extension|file):/.test(href)) {
                return href;
            }

            // 如果已经是代理链接，跳过
            if (href.startsWith(baseProxyUrl)) return href;

            // 如果是完整 URL（http/https）
            if (href.startsWith('http://') || href.startsWith('https://')) {
                return `${baseProxyUrl}?url=${href}`;
            }

            // 处理 //example.com 这种协议相对地址
            if (href.startsWith('//')) {
                return `${baseProxyUrl}?url=${targetProtocol}${href}`;
            }

            // 处理绝对路径（以 / 开头）
            if (href.startsWith('/')) {
                return `${baseProxyUrl}?url=${targetHost}${href}`;
            }

            // 处理相对路径（以 ./ 或 ../ 开头，或直接文件名）
            if (!href.startsWith('/') && !href.startsWith('http')) {
                // 获取当前目录路径
                let currentDir = basePath;
                if (!currentDir.endsWith('/')) {
                    const lastSlash = currentDir.lastIndexOf('/');
                    currentDir = lastSlash > 0 ? currentDir.substring(0, lastSlash + 1) : '/';
                }

                // 处理 ../ 和 ./
                let resolvedPath = href;
                if (href.startsWith('../')) {
                    let dirs = currentDir.split('/').filter(d => d);
                    const parts = href.split('/');
                    for (const part of parts) {
                        if (part === '..') {
                            dirs.pop();
                        } else if (part !== '.') {
                            dirs.push(part);
                        }
                    }
                    resolvedPath = '/' + dirs.join('/');
                } else if (href.startsWith('./')) {
                    resolvedPath = currentDir + href.substring(2);
                } else {
                    resolvedPath = currentDir + href;
                }

                // 确保路径以 / 开头
                if (!resolvedPath.startsWith('/')) {
                    resolvedPath = '/' + resolvedPath;
                }

                return `${baseProxyUrl}?url=${targetHost}${resolvedPath}`;
            }

            return href;
        };

        // 7. 🔧 HTML 全面重写
        if (isHtml) {
            // 重写所有标签属性
            const rewriteTag = (html, tag, attr) => {
                // 使用更精确的正则，处理单双引号和空格
                const regex = new RegExp(`<${tag}\\s+([^>]*?)${attr}=["']([^"']*)["']`, 'gi');
                return html.replace(regex, (match, attrs, value) => {
                    const newValue = proxyUrl(value);
                    return `<${tag} ${attrs}${attr}="${newValue}"`;
                });
            };

            // 重写常见标签
            responseBody = rewriteTag(responseBody, 'a', 'href');
            responseBody = rewriteTag(responseBody, 'link', 'href');
            responseBody = rewriteTag(responseBody, 'script', 'src');
            responseBody = rewriteTag(responseBody, 'img', 'src');
            responseBody = rewriteTag(responseBody, 'form', 'action');
            responseBody = rewriteTag(responseBody, 'iframe', 'src');
            responseBody = rewriteTag(responseBody, 'video', 'src');
            responseBody = rewriteTag(responseBody, 'audio', 'src');
            responseBody = rewriteTag(responseBody, 'source', 'src');
            responseBody = rewriteTag(responseBody, 'track', 'src');

            // 重写 CSS url()
            responseBody = responseBody.replace(
                /url\(["']?([^"')]*)["']?\)/gi,
                (match, cssUrl) => {
                    const newUrl = proxyUrl(cssUrl.trim());
                    return `url("${newUrl}")`;
                }
            );

            // 重写 meta refresh/redirect
            responseBody = responseBody.replace(
                /<meta\s+([^>]*?)content=["']([^"']*)["']/gi,
                (match, attrs, content) => {
                    if (/url|URL|refresh|redirect/i.test(attrs)) {
                        // 提取 URL 部分
                        const urlMatch = content.match(/url=(.+)/i);
                        if (urlMatch) {
                            const newUrl = proxyUrl(urlMatch[1].trim());
                            return `<meta ${attrs}content="0; url=${newUrl}"`;
                        }
                    }
                    return match;
                }
            );

            // 重写 style 标签内的 CSS
            responseBody = responseBody.replace(
                /<style([^>]*)>([\s\S]*?)<\/style>/gi,
                (match, attrs, cssContent) => {
                    const newCss = cssContent.replace(
                        /url\(["']?([^"')]*)["']?\)/gi,
                        (m, cssUrl) => {
                            const newUrl = proxyUrl(cssUrl.trim());
                            return `url("${newUrl}")`;
                        }
                    );
                    return `<style${attrs}>${newCss}</style>`;
                }
            );

            // 重写 onload/onclick 等事件中的路径
            responseBody = responseBody.replace(
                /on(load|click|mouseover|mouseout|focus|blur|change|submit|reset)=["']([^"']*)["']/gi,
                (match, event, code) => {
                    // 简单替换 location.href 和 window.open 中的路径
                    let newCode = code.replace(
                        /(location\.href|window\.open)\s*=\s*["']([^"']*)["']/gi,
                        (m, func, path) => {
                            return `${func} = "${proxyUrl(path)}"`;
                        }
                    );
                    newCode = newCode.replace(
                        /(location\.href|window\.open)\s*\(\s*["']([^"']*)["']\s*\)/gi,
                        (m, func, path) => {
                            return `${func}("${proxyUrl(path)}")`;
                        }
                    );
                    return `on${event}="${newCode}"`;
                }
            );
        }

        // 8. 🔧 CSS 全面重写
        if (isCss) {
            // 处理 CSS 中的 url()
            responseBody = responseBody.replace(
                /url\(["']?([^"')]*)["']?\)/gi,
                (match, cssUrl) => {
                    const newUrl = proxyUrl(cssUrl.trim());
                    return `url("${newUrl}")`;
                }
            );

            // 处理 @import
            responseBody = responseBody.replace(
                /@import\s+["']([^"']*)["']/gi,
                (match, importUrl) => {
                    const newUrl = proxyUrl(importUrl);
                    return `@import "${newUrl}"`;
                }
            );

            // 处理 @font-face 中的 src
            responseBody = responseBody.replace(
                /src:\s*url\(["']?([^"')]*)["']?\)/gi,
                (match, fontUrl) => {
                    const newUrl = proxyUrl(fontUrl.trim());
                    return `src: url("${newUrl}")`;
                }
            );
        }

        // 9. 🔧 JavaScript 全面重写
        if (isJs) {
            // 处理字符串中的 URL（简单替换）
            const jsProxy = (str) => {
                if (!str) return str;
                // 替换引号内的 URL
                return str.replace(
                    /["']([^"']*\.(css|js|png|jpg|jpeg|gif|svg|webp|woff|woff2|ttf|eot|json|xml|html|htm)[^"']*)["']/gi,
                    (match, path) => {
                        if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('/')) {
                            return `"${proxyUrl(path)}"`;
                        }
                        return match;
                    }
                );
            };

            // 处理 fetch() 和 XMLHttpRequest 中的 URL
            responseBody = responseBody.replace(
                /(fetch|axios\.get|axios\.post|axios\.put|axios\.delete)\s*\(\s*["']([^"']*)["']/gi,
                (match, method, path) => {
                    if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('/')) {
                        return `${method}("${proxyUrl(path)}"`;
                    }
                    return match;
                }
            );

            // 处理 location.href / window.location / document.location
            responseBody = responseBody.replace(
                /(location|window\.location|document\.location)\.(href|assign|replace)\s*=\s*["']([^"']*)["']/gi,
                (match, obj, method, path) => {
                    return `${obj}.${method} = "${proxyUrl(path)}"`;
                }
            );

            // 处理 XMLHttpRequest.open
            responseBody = responseBody.replace(
                /\.open\s*\(\s*["']([^"']*)["']\s*,\s*["']([^"']*)["']/gi,
                (match, method, path) => {
                    if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('/')) {
                        return `.open("${method}", "${proxyUrl(path)}"`;
                    }
                    return match;
                }
            );

            // 处理 import() 动态导入
            responseBody = responseBody.replace(
                /import\s*\(\s*["']([^"']*)["']\s*\)/gi,
                (match, path) => {
                    if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('/')) {
                        return `import("${proxyUrl(path)}")`;
                    }
                    return match;
                }
            );

            // 处理 new Worker()
            responseBody = responseBody.replace(
                /new\s+Worker\s*\(\s*["']([^"']*)["']/gi,
                (match, path) => {
                    if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('/')) {
                        return `new Worker("${proxyUrl(path)}"`;
                    }
                    return match;
                }
            );
        }

        // 10. 构造响应
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
        if (isJs) {
            newResponse.headers.set('Content-Type', 'application/javascript; charset=utf-8');
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