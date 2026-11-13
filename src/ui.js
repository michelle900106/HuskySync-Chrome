// Small DOM helpers for the extension pages. Text from HuskyCT is always
// inserted as text nodes, never as HTML.

export const STATUS_LABELS = {
  SUBMITTED: 'Submitted',
  NOT_SUBMITTED: 'Not submitted',
  OVERDUE: 'Overdue',
};

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (name === 'className') node.className = value;
    else if (value === true) node.setAttribute(name, '');
    else node.setAttribute(name, String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Only http(s) links from imported data are rendered as links. */
export function safeHref(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function relativeDue(iso, now = Date.now()) {
  const minutes = Math.round((Date.parse(iso) - now) / 60000);
  const abs = Math.abs(minutes);
  const text = abs < 60 ? `${abs} min` : abs < 48 * 60 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} days`;
  return minutes >= 0 ? `in ${text}` : `${text} ago`;
}

export function timeAgo(iso) {
  return iso ? relativeDue(iso) : 'never';
}

export function sendSync() {
  return chrome.runtime.sendMessage({ type: 'sync' });
}
