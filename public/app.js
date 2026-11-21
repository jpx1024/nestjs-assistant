const byId = (id) => document.getElementById(id);
const workspace = byId('workspace');
const history = byId('history');
const search = byId('search');
const newChat = byId('new-chat');
const mobileMenu = byId('mobile-menu');
const themeButton = byId('theme-button');
const chatScroll = byId('chat-scroll');
const welcome = byId('welcome');
const messages = byId('messages');
const composer = byId('composer');
const input = byId('message-input');
const thinkingToggle = byId('thinking-toggle');
const sendButton = byId('send-button');
const stopButton = byId('stop-button');
const notice = byId('notice');
const dialog = byId('conversation-dialog');
const dialogName = byId('dialog-name');
const dialogSubmit = byId('dialog-submit');
const workspaceNotice = byId('workspace-notice');
const workspaceButtons = [...document.querySelectorAll('[data-workspace]')];

const workspaces = {
    chat: {
        api: '/api/conversations',
        model: '/api/chat/model',
        preference: 'assistant-conversation',
    },
    agent: {
        api: '/api/agent/conversations',
        model: '/api/agent/model',
        preference: 'assistant-agent-conversation',
    },
};
const workspaceKey = 'assistant-workspace';
const themeKey = 'assistant-theme';
const defaultTitle = '新对话';
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const reasoningByConversation = new Map();
const drafts = { chat: '', agent: '' };
const state = {
    mode: readPreference(workspaceKey) === 'agent' ? 'agent' : 'chat',
    conversation: null,
    history: [],
    pending: null,
    dialogAction: null,
    modelAvailable: true,
    thinkingAvailable: false,
    thinking: false,
};

let historyRequest = 0;
let conversationRequest = 0;
let searchTimer;
let noticeTimer;

const markdown = window
    .markdownit?.({
        html: false,
        highlight(code, language) {
            if (language && window.hljs?.getLanguage(language)) {
                return window.hljs.highlight(code, {
                    language,
                    ignoreIllegals: true,
                }).value;
            }
            return '';
        },
    })
    .disable('image');

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function icon(name) {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    const use = document.createElementNS(namespace, 'use');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
}

function readPreference(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function savePreference(key, value) {
    try {
        if (value === null) {
            localStorage.removeItem(key);
        } else {
            localStorage.setItem(key, value);
        }
    } catch {}
}

function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const label = theme === 'dark' ? '切换至白天模式' : '切换至黑夜模式';
    themeButton.setAttribute('aria-label', label);
    themeButton.title = label;
}

function setSidebar(open, restoreFocus = false) {
    workspace.classList.toggle('sidebar-open', open);
    mobileMenu.setAttribute('aria-expanded', String(open));
    mobileMenu.setAttribute(
        'aria-label',
        open ? '关闭会话侧栏' : '打开会话侧栏',
    );
    if (restoreFocus) mobileMenu.focus();
}

function report(text) {
    clearTimeout(noticeTimer);
    notice.textContent = text;
    notice.hidden = false;
    noticeTimer = setTimeout(() => {
        notice.hidden = true;
    }, 4200);
}

function publicError(message) {
    if (/too long/i.test(message)) return '模型响应超时，可以重试。';
    if (/output token limit/i.test(message)) return '已达到生成上限。';
    if (/without a text answer/i.test(message))
        return '模型没有返回正文，可以重试。';
    if (/cannot switch thinking modes/i.test(message))
        return '当前模型无法切换思考模式。';
    if (/AGENT_MODEL/.test(message))
        return '请在 .env 设置 AGENT_MODEL 后重启。';
    if (/AGENT_API_KEY/.test(message)) return '请在 .env 设置 Agent 模型密钥。';
    if (/tool step limit/i.test(message))
        return '已达到 Agent 的工具调用轮数上限。';
    if (/model or tool request failed/i.test(message))
        return 'Agent 执行失败，可以稍后重试。';
    if (/already in progress/i.test(message)) return '这段对话正在生成回复。';
    if (/reply could not be saved/i.test(message)) return '回复未能保存。';
    if (/conversation not found/i.test(message)) return '找不到这段对话。';
    return '请求未完成，可以稍后重试。';
}

async function checkResponse(response) {
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(publicError(String(body.message ?? '')));
    }
    return response;
}

async function request(path, { method = 'GET', body } = {}) {
    const response = await checkResponse(
        await fetch(path, {
            method,
            ...(body === undefined
                ? {}
                : {
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(body),
                  }),
        }),
    );
    return response.status === 204 ? null : response.json();
}

function conversationPath(id) {
    return workspaces[state.mode].api + '/' + encodeURIComponent(id);
}

function nearBottom() {
    return (
        chatScroll.scrollHeight -
            chatScroll.scrollTop -
            chatScroll.clientHeight <
        96
    );
}

function scrollToLatest() {
    chatScroll.scrollTop = chatScroll.scrollHeight;
}

function updateControls() {
    const busy = Boolean(state.pending);
    for (const button of workspaceButtons) {
        button.disabled = busy;
        button.setAttribute(
            'aria-pressed',
            String(button.dataset.workspace === state.mode),
        );
    }
    thinkingToggle.hidden = !state.thinkingAvailable;
    thinkingToggle.disabled = busy;
    thinkingToggle.setAttribute('aria-pressed', String(state.thinking));
    sendButton.hidden = busy;
    sendButton.disabled = !state.modelAvailable || !input.value.trim();
    stopButton.hidden = !busy;
    stopButton.disabled = Boolean(state.pending?.abort.signal.aborted);
    newChat.disabled = busy;
    for (const item of history.querySelectorAll('.history-item')) {
        item.disabled = busy;
    }
}

function resizeInput() {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
    updateControls();
}

function positionMenu(menu, summary) {
    const rect = summary.getBoundingClientRect();
    menu.style.left = Math.max(8, rect.right - menu.offsetWidth) + 'px';
    const below = rect.bottom + menu.offsetHeight + 8 <= innerHeight;
    menu.style.top =
        (below ? rect.bottom + 3 : rect.top - menu.offsetHeight - 3) + 'px';
}

function historyRow(conversation) {
    const row = element('div', 'history-row');
    const item = element('button', 'history-item');
    item.type = 'button';
    item.title = conversation.title;
    if (state.conversation?.id === conversation.id) {
        item.setAttribute('aria-current', 'true');
    }
    item.append(icon('chat'), element('span', '', conversation.title));
    item.addEventListener('click', () => {
        openConversation(conversation.id).catch(() => report('会话加载失败。'));
        setSidebar(false);
    });

    const options = element('details', 'history-options');
    options.name = 'conversation-options';
    const summary = element('summary', 'icon-button');
    summary.setAttribute('aria-label', '管理“' + conversation.title + '”');
    summary.append(icon('more'));
    const menu = element('div', 'history-menu');
    const rename = element('button', '', '重命名');
    const remove = element('button', 'delete-action', '删除');
    rename.prepend(icon('pen'));
    remove.prepend(icon('trash'));
    rename.addEventListener('click', () => openDialog('rename', conversation));
    remove.addEventListener('click', () => openDialog('delete', conversation));
    menu.append(rename, remove);
    options.append(summary, menu);
    options.addEventListener('toggle', () => {
        if (options.open) positionMenu(menu, summary);
    });
    row.append(item, options);
    return row;
}

function renderHistory() {
    history.replaceChildren();
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const groups = new Map([
        ['今天', []],
        ['昨天', []],
        ['更早', []],
    ]);
    for (const conversation of state.history) {
        const day = new Date(conversation.updatedAt).toDateString();
        const group =
            day === today.toDateString()
                ? '今天'
                : day === yesterday.toDateString()
                  ? '昨天'
                  : '更早';
        groups.get(group).push(conversation);
    }
    for (const [label, entries] of groups) {
        if (!entries.length) continue;
        const section = element('section', 'history-section');
        section.append(element('h2', 'history-label', label));
        for (const entry of entries) section.append(historyRow(entry));
        history.append(section);
    }
    if (!state.history.length) {
        const text = search.value.trim() ? '没有匹配的会话' : '暂无历史对话';
        history.append(element('p', 'history-empty', text));
    }
    updateControls();
}

async function loadHistory() {
    const version = ++historyRequest;
    const rows = await request(
        workspaces[state.mode].api +
            '?q=' +
            encodeURIComponent(search.value.trim()),
    );
    if (version === historyRequest) {
        state.history = rows;
        renderHistory();
    }
}

function showMarkdown(node, text) {
    if (!markdown) {
        node.textContent = text;
        return;
    }
    node.innerHTML = markdown.render(text);
    for (const code of node.querySelectorAll('pre > code')) {
        const pre = code.parentElement;
        const block = element('div', 'code-block');
        const heading = element('div', 'code-heading');
        const language = [...code.classList].find((part) =>
            part.startsWith('language-'),
        );
        const copy = element('button', 'icon-button copy-code');
        copy.type = 'button';
        copy.setAttribute('aria-label', '复制代码');
        copy.title = '复制代码';
        copy.append(icon('copy'));
        heading.append(element('span', '', language?.slice(9) || '代码'), copy);
        pre.replaceWith(block);
        block.append(heading, pre);
    }
    for (const link of node.querySelectorAll('a[href]')) {
        if (link.origin !== location.origin) {
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
        }
    }
}

function fillReasoning(body, reasoning) {
    if (!reasoning?.text) return;
    let panel = body.querySelector(':scope > .reasoning-panel');
    if (!panel) {
        panel = element('details', 'reasoning-panel');
        panel.open = reasoning.open;
        panel.append(
            element('summary', '', '思考过程'),
            element('div', 'reasoning-text'),
        );
        panel.addEventListener('toggle', () => {
            reasoning.open = panel.open;
        });
        body.prepend(panel);
    }
    const text = panel.lastElementChild;
    if (text.textContent !== reasoning.text) {
        const follow =
            text.scrollHeight - text.scrollTop - text.clientHeight < 24;
        text.textContent = reasoning.text;
        if (follow) text.scrollTop = text.scrollHeight;
    }
}

function fillSearches(body, searches) {
    if (!searches?.length) return;
    let panel = body.querySelector(':scope > .agent-search-panel');
    if (!panel) {
        panel = element('details', 'agent-search-panel');
        panel.open = true;
        panel.append(element('summary'), element('div', 'agent-search-list'));
        body.insertBefore(panel, body.querySelector(':scope > .reply-body'));
    }
    const version = searches
        .map(({ id, status }) => id + ':' + status)
        .join(',');
    if (panel.dataset.version === version) return;
    panel.dataset.version = version;
    panel.firstElementChild.textContent = searches.some(
        (item) => item.status === 'searching',
    )
        ? '正在搜索…'
        : `联网搜索（${searches.length}）`;
    const list = panel.lastElementChild;
    list.replaceChildren();
    for (const activity of searches) {
        const row = element('div');
        const label =
            activity.status === 'failed'
                ? '搜索失败'
                : activity.status === 'stopped'
                  ? '已取消'
                  : activity.status === 'complete' &&
                      activity.sources.length === 0
                    ? '无匹配结果'
                    : '';
        row.append(
            element(
                'p',
                'agent-search-query',
                activity.query + (label ? ' · ' + label : ''),
            ),
        );
        if (activity.sources.length) {
            const sources = element('ol', 'agent-search-sources');
            for (const source of activity.sources) {
                if (
                    typeof source.url !== 'string' ||
                    !/^https?:\/\//i.test(source.url)
                )
                    continue;
                const item = element('li');
                const link = element('a', '', source.title || source.url);
                link.href = source.url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                item.append(link);
                sources.append(item);
            }
            row.append(sources);
        }
        list.append(row);
    }
}

function fillAssistant(body, message, canRetry) {
    const reasoning =
        message.reasoning ??
        reasoningByConversation.get(state.conversation?.id)?.get(message.id);
    fillReasoning(body, reasoning);
    fillSearches(body, message.searches);
    let replyBody = body.querySelector(':scope > .reply-body');
    if (!replyBody) {
        replyBody = element('div', 'reply-body');
        body.append(replyBody);
    }
    const content = element('div', 'markdown');
    showMarkdown(content, message.content);
    replyBody.replaceChildren(content);
    if (message.status === 'complete') return;

    const text =
        message.note ||
        {
            streaming: message.searches?.some(
                (activity) => activity.status === 'searching',
            )
                ? '正在查找资料…'
                : message.thinking
                  ? message.content
                      ? '正在作答…'
                      : '正在思考…'
                  : '正在生成…',
            stopped: '已停止生成',
            failed: '回复生成失败',
        }[message.status];
    const status = element('div', 'reply-status');
    status.dataset.status = message.status;
    if (message.status === 'streaming') {
        const dots = element('span', 'pending-dots');
        dots.setAttribute('aria-hidden', 'true');
        dots.append(element('i'), element('i'), element('i'));
        status.append(dots);
    }
    status.append(element('span', '', text));
    if (canRetry && ['stopped', 'failed'].includes(message.status)) {
        const retry = element('button', 'retry-reply', '重试');
        retry.type = 'button';
        status.append(retry);
    }
    replyBody.append(status);
}

function renderConversation({ follow = true } = {}) {
    const conversation = state.conversation;
    byId('conversation-title').textContent =
        conversation?.title ?? defaultTitle;
    const rows = conversation?.messages ?? [];
    welcome.hidden = Boolean(rows.length);
    messages.hidden = !rows.length;
    messages.replaceChildren();
    for (const [index, message] of rows.entries()) {
        const item = element('article', 'message message-' + message.role);
        item.setAttribute(
            'aria-label',
            message.role === 'user' ? '你的消息' : '助手回复',
        );
        if (message.role === 'assistant') {
            const avatar = element('span', 'assistant-avatar');
            avatar.append(icon('spark'));
            item.append(avatar);
        }
        const body = element('div', 'message-content');
        if (message.role === 'user') {
            body.textContent = message.content;
        } else {
            fillAssistant(
                body,
                message,
                !state.pending && index === rows.length - 1,
            );
        }
        item.append(body);
        messages.append(item);
    }
    if (follow) scrollToLatest();
}

function setConversation(conversation) {
    state.conversation = conversation;
    savePreference(workspaces[state.mode].preference, conversation?.id ?? null);
    renderConversation();
    renderHistory();
}

async function openConversation(id) {
    if (state.pending) return;
    const version = ++conversationRequest;
    const conversation = await request(conversationPath(id));
    if (version === conversationRequest && !state.pending) {
        setConversation(conversation);
    }
}

function startNew() {
    if (state.pending) return;
    conversationRequest++;
    input.value = '';
    resizeInput();
    setConversation(null);
    setSidebar(false);
    input.focus();
}

async function reloadAfterReply(id) {
    let conversation;
    for (let attempt = 0; attempt < 9; attempt++) {
        conversation = await request(conversationPath(id));
        if (conversation.messages.at(-1)?.status !== 'streaming') break;
        await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return conversation;
}

async function* streamEvents(response) {
    if (
        !response.body ||
        !response.headers.get('Content-Type')?.includes('text/event-stream')
    ) {
        throw new Error('无法读取模型返回的流。');
    }
    const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
    let buffer = '';
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            const packets = buffer.split(/\r?\n\r?\n/);
            buffer = packets.pop();
            for (const packet of packets) {
                const data = packet
                    .split(/\r?\n/)
                    .filter((line) => line.startsWith('data:'))
                    .map((line) => line.slice(5).trimStart())
                    .join('\n');
                if (data === '[DONE]') return;
                if (data) yield JSON.parse(data);
            }
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

async function sendReply({ retry = false } = {}) {
    if (state.pending || !state.modelAvailable) return;
    const text = input.value.trim();
    if (!retry && !text) return;
    const pending = { abort: new AbortController() };
    state.pending = pending;
    conversationRequest++;
    updateControls();

    let originalCount;
    let id;
    let reply;
    let error;
    let optimistic = false;
    let frame;

    try {
        if (!state.conversation) {
            const created = await request(workspaces[state.mode].api, {
                method: 'POST',
            });
            setConversation({ ...created, messages: [] });
        }
        if (pending.abort.signal.aborted) return;

        const conversation = state.conversation;
        id = conversation.id;
        originalCount = conversation.messages.length;
        const thinking = retry
            ? conversation.messages.at(-2)?.thinking
            : state.thinkingAvailable
              ? state.thinking
              : undefined;
        reply = {
            role: 'assistant',
            content: '',
            status: 'streaming',
            thinking,
            reasoning: { text: '', open: true },
            searches: [],
        };
        if (retry) {
            conversation.messages.splice(-1, 1, reply);
        } else {
            conversation.messages.push(
                { role: 'user', content: text, status: 'complete', thinking },
                reply,
            );
            input.value = '';
            resizeInput();
        }
        optimistic = true;
        renderConversation();
        const live =
            messages.lastElementChild.querySelector('.message-content');
        const paint = () => {
            frame = undefined;
            const follow = nearBottom();
            fillAssistant(live, reply, false);
            if (follow) scrollToLatest();
        };
        const path =
            conversationPath(id) + '/messages' + (retry ? '/retry' : '');
        const response = await checkResponse(
            await fetch(path, {
                method: 'POST',
                signal: pending.abort.signal,
                ...(retry
                    ? {}
                    : {
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ content: text, thinking }),
                      }),
            }),
        );
        for await (const part of streamEvents(response)) {
            if (part.type === 'text-delta') {
                reply.content += part.delta;
                frame ??= requestAnimationFrame(paint);
            } else if (part.type === 'reasoning-delta' && thinking) {
                reply.reasoning.text += part.delta;
                frame ??= requestAnimationFrame(paint);
            } else if (part.type === 'data-agent-search') {
                const activity = part.data;
                const index = reply.searches.findIndex(
                    ({ id }) => id === activity.id,
                );
                if (index < 0) reply.searches.push(activity);
                else reply.searches[index] = activity;
                frame ??= requestAnimationFrame(paint);
            } else if (part.type === 'error') {
                throw new Error(publicError(part.errorText));
            } else if (part.type === 'finish') {
                reply.status = 'complete';
            }
        }
        if (reply.status === 'streaming') {
            throw new Error('连接已结束，可以重试。');
        }
    } catch (failure) {
        if (!pending.abort.signal.aborted) {
            error = failure instanceof Error ? failure.message : '请求未完成。';
        }
    } finally {
        if (frame !== undefined) cancelAnimationFrame(frame);
        if (reply?.status === 'streaming') {
            reply.status = pending.abort.signal.aborted ? 'stopped' : 'failed';
        }
        let saved;
        if (id) {
            saved = await reloadAfterReply(id).catch(() => null);
        }
        state.pending = null;
        if (saved) {
            if (
                !retry &&
                optimistic &&
                saved.messages.length === originalCount &&
                !input.value
            ) {
                input.value = text;
                resizeInput();
            }
            const assistant =
                saved.messages[retry ? originalCount - 1 : originalCount + 1];
            if (assistant?.role === 'assistant') {
                const reasoning = reasoningByConversation.get(id) ?? new Map();
                if (reply?.reasoning.text) {
                    reasoning.set(assistant.id, reply.reasoning);
                    reasoningByConversation.set(id, reasoning);
                } else if (retry) {
                    reasoning.delete(assistant.id);
                }
                if (error && assistant.status === 'failed')
                    assistant.note = error;
            }
            state.conversation = saved;
        } else if (error && reply) {
            reply.note = error;
        }
        if (error) report(error);
        renderConversation({ follow: nearBottom() });
        renderHistory();
        loadHistory().catch(() => {});
    }
}

function openDialog(action, conversation) {
    if (state.pending && state.conversation?.id === conversation.id) return;
    const rename = action === 'rename';
    state.dialogAction = { action, conversation };
    byId('dialog-title').textContent = rename ? '重命名对话' : '删除对话';
    byId('dialog-copy').textContent =
        '确定删除“' + conversation.title + '”及其消息吗？';
    byId('dialog-copy').hidden = rename;
    byId('dialog-field').hidden = !rename;
    dialogName.required = rename;
    dialogName.value = rename ? conversation.title : '';
    dialogSubmit.textContent = rename ? '保存' : '删除';
    dialogSubmit.classList.toggle('danger-button', !rename);
    dialogSubmit.disabled = false;
    for (const menu of history.querySelectorAll('details[open]'))
        menu.open = false;
    dialog.showModal();
    if (rename) {
        dialogName.focus();
        dialogName.select();
    } else {
        byId('dialog-cancel').focus();
    }
}

byId('conversation-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const { action, conversation } = state.dialogAction;
    const path = conversationPath(conversation.id);
    dialogSubmit.disabled = true;
    try {
        if (action === 'rename') {
            const title = dialogName.value.trim();
            if (!title) {
                dialogName.focus();
                return;
            }
            const renamed = await request(path, {
                method: 'PATCH',
                body: { title },
            });
            if (state.conversation?.id === renamed.id) {
                state.conversation.title = renamed.title;
                byId('conversation-title').textContent = renamed.title;
            }
        } else {
            await request(path, { method: 'DELETE' });
            reasoningByConversation.delete(conversation.id);
            if (state.conversation?.id === conversation.id) startNew();
        }
        dialog.close();
        await loadHistory();
    } catch (failure) {
        report(failure.message);
    } finally {
        dialogSubmit.disabled = false;
    }
});

for (const id of ['dialog-close', 'dialog-cancel']) {
    byId(id).addEventListener('click', () => dialog.close());
}

themeButton.addEventListener('click', () => {
    const theme =
        document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    savePreference(themeKey, theme);
    setTheme(theme);
});
systemTheme.addEventListener('change', ({ matches }) => {
    if (!readPreference(themeKey)) setTheme(matches ? 'dark' : 'light');
});
setTheme(document.documentElement.dataset.theme);

mobileMenu.addEventListener('click', () =>
    setSidebar(!workspace.classList.contains('sidebar-open')),
);
byId('sidebar-overlay').addEventListener('click', () =>
    setSidebar(false, true),
);
newChat.addEventListener('click', startNew);

search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(
        () => loadHistory().catch(() => report('历史记录加载失败。')),
        160,
    );
});

document.addEventListener('click', (event) => {
    for (const menu of history.querySelectorAll('details[open]')) {
        if (!menu.contains(event.target)) menu.open = false;
    }
});

history.addEventListener('scroll', () => {
    for (const menu of history.querySelectorAll('details[open]'))
        menu.open = false;
});

document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSidebar(true);
        requestAnimationFrame(() => search.focus());
    } else if (
        event.key === 'Escape' &&
        !dialog.open &&
        workspace.classList.contains('sidebar-open')
    ) {
        setSidebar(false, true);
    }
});

input.addEventListener('input', resizeInput);
input.addEventListener('keydown', (event) => {
    if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.isComposing &&
        event.keyCode !== 229
    ) {
        event.preventDefault();
        composer.requestSubmit();
    }
});
composer.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendReply();
});
stopButton.addEventListener('click', () => {
    state.pending?.abort.abort();
    updateControls();
});
thinkingToggle.addEventListener('click', () => {
    state.thinking = !state.thinking;
    updateControls();
});

welcome.addEventListener('click', (event) => {
    const suggestion = event.target.closest('[data-prompt]');
    if (!suggestion) return;
    input.value = suggestion.dataset.prompt;
    resizeInput();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
});

messages.addEventListener('click', async (event) => {
    if (event.target.closest('.retry-reply')) {
        void sendReply({ retry: true });
        return;
    }
    const copy = event.target.closest('.copy-code');
    if (copy) {
        const code = copy.closest('.code-block').querySelector('pre code');
        try {
            await navigator.clipboard.writeText(code.textContent);
            report('代码已复制。');
        } catch {
            report('无法访问剪贴板，请手动复制代码。');
        }
    }
});

async function loadModel() {
    const label = byId('model-label');
    const pill = byId('model-pill');
    const mode = state.mode;
    try {
        const {
            provider,
            model,
            thinkingAvailable,
            modelAvailable,
            searchAvailable,
        } = await request(workspaces[mode].model);
        if (mode !== state.mode) return;
        const name = provider === 'lm-studio' ? 'LM Studio' : 'OpenAI';
        pill.title = model ? name + ' · ' + model : 'Agent 模型未配置';
        label.textContent = model ?? '模型未配置';
        state.thinkingAvailable = thinkingAvailable === true;
        state.thinking = state.thinkingAvailable && state.thinking;
        state.modelAvailable = modelAvailable !== false;
        const noticeText = !state.modelAvailable
            ? model
                ? '在 .env 设置 AGENT_API_KEY 后重启。'
                : '在 .env 设置 AGENT_MODEL 后重启。'
            : mode === 'agent' && !searchAvailable
              ? '联网搜索需要配置 DEEPSEEK_SEARCH_API_KEY。'
              : '';
        workspaceNotice.textContent = noticeText;
        workspaceNotice.hidden = !noticeText;
        updateControls();
    } catch {
        if (mode !== state.mode) return;
        pill.title = '模型配置读取失败';
        label.textContent = '模型配置不可用';
        if (mode === 'agent') {
            workspaceNotice.textContent =
                'Agent 配置读取失败，请刷新页面后重试。';
            workspaceNotice.hidden = false;
        }
    }
}

function showWorkspace() {
    const agent = state.mode === 'agent';
    workspaceNotice.hidden = true;
    byId('welcome-title').textContent = agent
        ? 'Agent 工作区'
        : '今天想聊些什么？';
    byId('welcome-description').textContent = agent
        ? '查找网页资料、核对来源，并把搜索记录留在会话里。'
        : '从一个问题、一个想法，或一段代码开始。';
    state.thinkingAvailable = false;
    state.modelAvailable = !agent;
    byId('model-label').textContent = '读取模型中';
    renderConversation();
    renderHistory();
    void loadModel();
    void loadHistory().catch(() => report('历史记录加载失败。'));
    const { preference } = workspaces[state.mode];
    const savedId = readPreference(preference);
    if (savedId) {
        void openConversation(savedId).catch(() =>
            savePreference(preference, null),
        );
    }
}

for (const button of workspaceButtons) {
    button.addEventListener('click', () => {
        const mode = button.dataset.workspace;
        if (state.pending || mode === state.mode) return;
        drafts[state.mode] = input.value;
        conversationRequest++;
        historyRequest++;
        clearTimeout(searchTimer);
        state.mode = mode;
        savePreference(workspaceKey, mode);
        state.conversation = null;
        state.history = [];
        state.thinking = false;
        search.value = '';
        input.value = drafts[mode];
        resizeInput();
        showWorkspace();
    });
}

resizeInput();
showWorkspace();
