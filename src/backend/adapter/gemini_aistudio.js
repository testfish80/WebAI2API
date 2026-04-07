/**
 * @fileoverview Google AI Studio 文本生成适配器
 * 核心逻辑：使用用户提供的递归解析算法，针对 MakerSuite 响应格式优化
 */

import {
    sleep,
    humanType,
    safeClick,
    uploadFilesViaChooser
} from '../engine/utils.js';
import {
    normalizePageError,
    normalizeHttpError,
    waitForInput,
    gotoWithCheck,
    waitApiResponse
} from '../utils/index.js';
import { logger } from '../../utils/logger.js';

const TARGET_URL = 'https://aistudio.google.com/prompts/new_chat';

async function generate(context, prompt, imgPaths, modelId, meta = {}) {
    const { page, config } = context;
    const waitTimeout = config?.backend?.pool?.waitTimeout ?? 180000;
    
    const inputLocator = page.locator('ms-prompt-box textarea');
    const runBtnLocator = page.locator('ms-run-button button');

    try {
        logger.info('适配器', '初始化 AI Studio...', meta);
        await gotoWithCheck(page, TARGET_URL);

        // 1. 强力清理 UI 干扰（防止点击失效导致重启）
        await page.evaluate(() => {
            const trash = ['.glue-cookie-notification-bar', '.cdk-overlay-backdrop', 'ms-user-education-tip', '.glue-cookie-notification-bar__accept'];
            trash.forEach(s => document.querySelectorAll(s).forEach(el => el.remove()));
        }).catch(() => {});

        // 2. 等待输入框
        await waitForInput(page, inputLocator, { click: true });

        // 3. 【关键】启动监听，匹配 MakerSuiteService 生成接口
        logger.debug('适配器', '启动 API 拦截...', meta);
        const apiResponsePromise = waitApiResponse(page, {
            urlMatch: 'google.internal.alkali.applications.makersuite.v1.MakerSuiteService/CreatePrompt',
            method: 'POST',
            timeout: waitTimeout,
            meta
        });

        // 4. 输入指令
        logger.info('适配器', '正在注入指令...', meta);
        await inputLocator.focus();
        await humanType(page, inputLocator, prompt);
        await sleep(1000); 

        // 5. 触发生成
        logger.info('适配器', '运行 (Control+Enter)...', meta);
        await inputLocator.press('Control+Enter');

        // 6. 监测生成过程
        let apiResponse;
        try {
            apiResponse = await apiResponsePromise;
            const bodyBuffer = await apiResponse.body();

            // 使用你提供的递归逻辑进行解析
            const result = parseMakerSuiteResponseAdvanced(bodyBuffer);

            if (result.text || result.reasoning) {
                logger.info('适配器', `成功提取结果: ${result.text.length} 字`, meta);
                return result;
            }
        } catch (e) {
            logger.warn('适配器', `API 拦截失败: ${e.message}，尝试 DOM 兜底`, meta);
        }

    } catch (err) {
        const pageError = normalizePageError(err, meta);
        if (pageError) return pageError;
        return { error: `AI Studio 任务故障: ${err.message}` };
    }
}

/**
 *  MakerSuite 响应解析（基于新的递归算法）
 */
function parseMakerSuiteResponseAdvanced(buf) {
    let fullText = '';
    let fullReasoning = '';
    
    try {
        let str = buf.toString('utf8').trim();
        // 剥离安全前缀
        if (str.startsWith(")]}'")) str = str.substring(4).trim();
        const data = JSON.parse(str);

        function extractRecursively(arr) {
            if (!Array.isArray(arr)) return;

            for (const item of arr) {
                if (Array.isArray(item)) {
                    // 检查是否是文本节点 [null, "text", ...]
                    if (item.length >= 2 && item[0] === null && typeof item[1] === 'string') {
                        // 抓包数据：如果数组末尾标志位是 1，则通常是思考过程
                        const isThinking = item[item.length - 1] === 1;
                        if (isThinking) {
                            fullReasoning += item[1];
                        } else {
                            fullText += item[1];
                        }
                    } else {
                        // 继续递归
                        extractRecursively(item);
                    }
                }
            }
        }
        extractRecursively(data);
    } catch (e) {
        logger.debug('解析器', '解析 JSON 出错，可能不是预期的 RPC 格式');
    }

    return { 
        text: fullText.trim(), 
        reasoning: fullReasoning.trim() 
    };
}


export const manifest = {
    id: 'gemini_aistudio',
    displayName: 'Google AI Studio',
    description: '使用新的递归算法适配 MakerSuite 内部 RPC 协议',
    getTargetUrl: () => TARGET_URL,
    models: [
        { id: 'gemini-3-flash-preview', imagePolicy: 'optional', type: 'text' },
        { id: 'gemini-1.5-pro', imagePolicy: 'optional', type: 'text' }
    ],
    generate
};      
