// Replaces personal details in the current page before a documentation screenshot.
// Evaluated in the page by cdp.mjs as `(<this function>)(replacements)`.
//
// `replacements` maps text to find onto sample text, for example
//   { "jane@fabrikam.com": "avery.chen@contoso.com", "Jane Doe": "Avery Chen" }
// Keys are matched case-insensitively, longest first. A key starting with "=" only
// replaces a whole text node or attribute whose trimmed value equals the rest of the key
// (use it for short tokens such as avatar initials: { "=JD": "AC" }). The special key
// "@initials" sets the initials drawn on avatar images, which are replaced with a badge.
// Keep the real values in a local file outside the repository; never commit them.
/* global document, NodeFilter */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
(replacements) => {
  const initials = replacements['@initials'] ?? 'AC';
  const exact = new Map(
    Object.entries(replacements)
      .filter(([find]) => find.startsWith('='))
      .map(([find, replace]) => [find.slice(1), replace]),
  );
  const pairs = Object.entries(replacements)
    .filter(([find]) => find && !find.startsWith('@') && !find.startsWith('='))
    .sort((a, b) => b[0].length - a[0].length)
    .map(([find, replace]) => [new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), replace]);

  let changed = 0;
  const swap = (text) => {
    const trimmed = text.trim();
    let out = exact.has(trimmed) ? text.replace(trimmed, exact.get(trimmed)) : text;
    for (const [re, replace] of pairs) out = out.replace(re, replace);
    if (out !== text) changed++;
    return out;
  };

  const badge = `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#0f6cbd"/><text x="32" y="41" font-family="Segoe UI,Arial" font-size="26" font-weight="600" fill="#fff" text-anchor="middle">${initials}</text></svg>`,
  )}`;
  const isAvatar = (img) =>
    /avatars\.githubusercontent\.com|graph\.microsoft\.com|\/photo|gravatar/i.test(img.src) ||
    /avatar/i.test(`${img.className} ${img.alt}`);

  const visit = (root) => {
    const walker = root.createTreeWalker(root.body ?? root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const next = swap(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
    }
    for (const el of root.querySelectorAll('[title], [aria-label], [placeholder], [alt], [data-tooltip]')) {
      for (const attr of ['title', 'aria-label', 'placeholder', 'alt', 'data-tooltip']) {
        const value = el.getAttribute(attr);
        if (value) {
          const next = swap(value);
          if (next !== value) el.setAttribute(attr, next);
        }
      }
    }
    for (const field of root.querySelectorAll('input, textarea')) {
      const next = swap(field.value);
      if (next !== field.value) field.value = next;
    }
    for (const img of root.querySelectorAll('img')) {
      if (isAvatar(img)) {
        img.srcset = '';
        img.src = badge;
        changed++;
      }
    }
    for (const frame of root.querySelectorAll('iframe')) {
      try {
        if (frame.contentDocument) visit(frame.contentDocument);
      } catch {
        // Cross-origin frames can't be read; scrub them through their own target.
      }
    }
  };

  visit(document);
  return `scrubbed ${changed} value(s)`;
};
