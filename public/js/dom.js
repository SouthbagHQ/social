// Tiny DOM helper. No framework, no build step — same as Southbag Online Banking.
//
//   h('button.btn.primary', { onclick: save, disabled: busy }, 'Post')
//   h('a', { href: '/@kevin', dataset: { id: 1 } }, [avatar(user), user.name])
//
// Tag strings accept `tag#id.class.class`. Children may be strings, numbers, nodes, arrays,
// or null/false (skipped). Props starting with `on` become event listeners; `class` may be an
// object of { name: condition }; `style` may be a string or object; `html` sets innerHTML
// (only ever pass trusted strings).

export function h(tag, props, ...children) {
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
    children.unshift(props);
    props = {};
  }
  const [, name = 'div', rest = ''] = tag.match(/^([\w-]*)(.*)$/);
  const el = document.createElement(name || 'div');
  for (const part of rest.match(/[#.][\w-]+/g) || []) {
    if (part[0] === '#') el.id = part.slice(1);
    else el.classList.add(part.slice(1));
  }
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class' || key === 'className') {
      if (typeof value === 'string') value.split(/\s+/).filter(Boolean).forEach(c => el.classList.add(c));
      else for (const [c, on] of Object.entries(value)) if (on) el.classList.add(c);
    } else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'ref') value(el);
    else if (key in el && !['list', 'form', 'type', 'width', 'height'].includes(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of [children].flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Replace all children. */
export const mount = (el, ...children) => { el.replaceChildren(); return append(el, children); };

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * Southbag Social has no icons. This used to return an SVG; it now returns an empty text node so
 * old call sites keep working. Every control must say what it does in words.
 */
export function icon() {
  return document.createTextNode('');
}
