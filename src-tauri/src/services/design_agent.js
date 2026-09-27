/*
 * Rayfin preview Design mode controller — v6 ("visual chat").
 *
 * Injected at document-start into EVERY frame of the preview webview (see
 * `preview.rs` `DESIGN_AGENT_JS` / `initialization_script_for_all_frames`) and
 * dormant until the host calls `enable(...)`. While on, it turns the live app
 * into precise context for Copilot:
 *   - hover shows a friendly label; click opens a small change card beside the
 *     element: say what should change (with suggestion chips), or use instant
 *     tweaks recorded in the app's own Tailwind vocabulary (text, color, size,
 *     weight, spacing, corners, shadow, align, hide, reorder), chart controls
 *     for Graphein charts, and AI "options" (variations) previewed live;
 *   - a Theme sheet previews app-wide tokens (accent / neutral palettes,
 *     corners, density, font) through CSS custom-property overrides;
 *   - a Polish panel lists AI suggestions with live previews.
 * Every change becomes (or updates) one numbered queue item per element. The
 * host mirrors the queue as chips in the chat composer and sends it to Copilot
 * as one turn. Previews are a disposable projection over the app: items are
 * serializable, re-anchored by selector / tag / text after SPA navigation, and
 * re-seeded by the host after a reload (`peek().sessionId === null`).
 *
 * Host comms are pull-based and JSON-only: `peek()` (cheap status, polled),
 * `snapshot()` (items, fetched when `version` changes), `command(cmd)` (host →
 * page; data-returning ops answer through `peek().results`) and `setTheme`.
 * The wire types live in `src/shared/design.ts`.
 *
 * Frames / roles: the host can only `eval` in the TOP frame. In the direct view
 * the top frame IS the app (role `direct`). In the Fabric-embedded view the app
 * runs in a CROSS-ORIGIN iframe; the top (Fabric shell) frame runs as a `relay`
 * that forwards commands to the app frame (role `app`) over origin-gated
 * `postMessage` and mirrors its state back.
 *
 * The native webview paints above all HTML, so all UI lives inside this page,
 * in a Shadow DOM attached to <html> (isolated from the app's CSS; survives SPA
 * body swaps). Everything is torn down on `disable()`.
 */
(function () {
  'use strict';
  var NS = '__rayfinDesign';
  var VERSION = 6;
  if (window[NS] && window[NS].__v === VERSION) return;

  var HOST_ID = '__rayfin_design_host';
  var THEME_STYLE_ID = '__rayfin_design_theme';
  var MSG = 'rayfin-design';
  var SVGNS = 'http://www.w3.org/2000/svg';
  var MAX_ITEMS = 60;
  var MAX_SIMILAR = 50;
  var MAX_SPEC_BYTES = 60000;

  // ---- icons (stroke, 24×24) -------------------------------------------------
  var ICONS = {
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    dock: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="M14 10l2 2-2 2"/>',
    parent: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/>',
    text: '<path d="M5 6h14M12 6v13M9 19h6"/>',
    color: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4-4-7.4-9-7.4z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="15.5" cy="7.5" r="1"/>',
    size: '<path d="M4 19l5-14 5 14M6 14h6M15 19l3-8 3 8M16 16.5h4"/>',
    spacing: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M3 3v18M21 3v18"/>',
    corners: '<path d="M4 20V10a6 6 0 0 1 6-6h10"/>',
    shadow: '<rect x="4" y="4" width="12" height="12" rx="2"/><path d="M20 8v10a2 2 0 0 1-2 2H8"/>',
    align: '<path d="M4 6h16M7 12h10M4 18h16"/>',
    hide: '<path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.2 2.3-2.4 3.5M6.2 6.2C4.2 7.6 2.7 9.6 2 12c1 2.5 5 7 10 7 1.6 0 3.1-.4 4.4-1.1"/>',
    move: '<path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    undo: '<path d="M4 9h11a5 5 0 0 1 0 10h-4"/><path d="M4 9l4-4M4 9l4 4"/>',
    trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
    check: '<path d="M5 12l5 5L20 7"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'
  };
  function svgIcon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  // ---- tiny DOM helpers -----------------------------------------------------
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v; // our static SVG icons only
        else if (k === 'class') el.className = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null || c === false) return;
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return el;
  }
  function iconButton(name, title, onClick, extraClass) {
    return h('button', { type: 'button', class: 'icon-btn' + (extraClass ? ' ' + extraClass : ''), title: title, 'aria-label': title, html: svgIcon(name), onclick: function (e) { e.stopPropagation(); onClick(e); } });
  }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function clip(s, max) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
  }
  /** The element's own (direct) text, ignoring child elements. */
  function ownText(el) {
    var s = '';
    for (var i = 0; el && i < el.childNodes.length; i++) if (el.childNodes[i].nodeType === 3) s += el.childNodes[i].nodeValue;
    return s.replace(/\s+/g, ' ').trim();
  }
  /** All visible text under `el`, with a space between separate text runs (unlike textContent). */
  function readableText(el) {
    if (!el) return '';
    var parts = [], total = 0, walker = document.createTreeWalker(el, 4 /* SHOW_TEXT */, null), n;
    while ((n = walker.nextNode()) && total < 400) {
      var t = n.nodeValue.replace(/\s+/g, ' ').trim();
      if (!t || isOurs(n.parentElement)) continue;
      var tag = n.parentElement && n.parentElement.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') continue;
      parts.push(t);
      total += t.length;
    }
    return parts.join(' ');
  }
  /** The first meaningful run of text under `el` (a card's title, a link's label…). */
  function firstText(el) {
    var walker = document.createTreeWalker(el, 4 /* SHOW_TEXT */, null), n;
    while ((n = walker.nextNode())) {
      var t = n.nodeValue.replace(/\s+/g, ' ').trim();
      var tag = n.parentElement && n.parentElement.tagName;
      if (t.length >= 2 && tag !== 'SCRIPT' && tag !== 'STYLE' && !isOurs(n.parentElement)) return t;
    }
    return '';
  }
  /** The text used to identify an element (stored on its target, compared when re-anchoring). */
  function elementText(el) { return clip(ownText(el) || readableText(el), 80); }
  function route() { try { return location.pathname + location.search + location.hash; } catch (e) { return '/'; } }
  function cloneVal(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; } }
  function cssEscape(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
  function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /** Best-effort unique CSS path for `el` in the live DOM. */
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    try {
      if (el.id && document.querySelectorAll('#' + cssEscape(el.id)).length === 1) return '#' + cssEscape(el.id);
      var testid = el.getAttribute('data-testid');
      if (testid) return '[data-testid="' + String(testid).replace(/"/g, '\\"') + '"]';
    } catch (e) {}
    var parts = [], node = el, depth = 0;
    while (node && node.nodeType === 1 && node !== document.documentElement && depth < 7) {
      var seg = node.tagName.toLowerCase();
      if (node !== el && node.id) {
        try { if (document.querySelectorAll('#' + cssEscape(node.id)).length === 1) { parts.unshift('#' + cssEscape(node.id)); break; } } catch (e) {}
      }
      var parent = node.parentElement;
      if (parent) {
        var same = 0, index = 0;
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) { same++; if (parent.children[i] === node) index = same; }
        }
        if (same > 1) seg += ':nth-of-type(' + index + ')';
      }
      parts.unshift(seg);
      node = parent; depth++;
    }
    return parts.join(' > ');
  }

  // Best-effort React component name from the fiber (present in dev builds;
  // minified in production — always a hint, never relied on).
  function componentHint(el) {
    try {
      var key = Object.keys(el).find(function (k) { return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0; });
      if (!key) return '';
      var f = el[key], hops = 0;
      while (f && hops < 12) {
        var t = f.type;
        if (t && typeof t !== 'string') {
          var name = t.displayName || t.name || (t.render && (t.render.displayName || t.render.name));
          if (name && name.length > 2 && name[0] === name[0].toUpperCase()) return name;
        }
        f = f.return; hops++;
      }
    } catch (e) {}
    return '';
  }
  function nearestHeading(el) {
    var n = el;
    for (var hop = 0; n && hop < 6; hop++) {
      var p = n;
      while (p) {
        if (p.nodeType === 1 && /^H[1-6]$/.test(p.tagName) && p !== el) return clip(readableText(p), 60);
        p = p.previousElementSibling;
      }
      n = n.parentElement;
    }
    return '';
  }
  function landmark(el) {
    var l = el.closest && el.closest('header,nav,main,aside,footer,section,[role="dialog"],[role="navigation"]');
    if (!l || l === el) return '';
    return l.getAttribute('role') || l.tagName.toLowerCase();
  }
  function dataAttrs(el) {
    var out = {}, n = 0;
    for (var i = 0; el.attributes && i < el.attributes.length && n < 8; i++) {
      var a = el.attributes[i];
      if (a.name.indexOf('data-') === 0 && a.name !== 'data-graphein-spec' && a.name.indexOf('data-rayfin') !== 0) { out[a.name] = clip(a.value, 80); n++; }
    }
    return n ? out : undefined;
  }

  // ---- roles, labels and targets --------------------------------------------
  var ROLE_NAMES = {
    button: 'Button', link: 'Link', heading: 'Heading', text: 'Text', image: 'Image', icon: 'Icon',
    field: 'Field', card: 'Card', list: 'List', item: 'List item', table: 'Table', chart: 'Chart',
    nav: 'Navigation', header: 'Header', footer: 'Footer', section: 'Section', container: 'Group', element: 'Element'
  };
  var TEXT_TAGS = /^(p|span|label|small|strong|em|b|i|blockquote|figcaption|dt|dd|caption|legend|code|time|abbr)$/;

  function chartRoot(el) { return el && el.closest ? el.closest('[data-graphein-spec]') : null; }
  function isTransparent(color) { return !color || color === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(color) || /\/\s*0\)$/.test(color); }

  /** A container that reads as a card: its own surface (fill, border or shadow) plus rounded corners. */
  function looksLikeCard(el, cs) {
    if (!el.children.length) return false;
    var surface = !isTransparent(cs.backgroundColor) || parseFloat(cs.borderTopWidth) > 0 || (cs.boxShadow && cs.boxShadow !== 'none');
    return surface && parseFloat(cs.borderTopLeftRadius) > 0;
  }

  function roleOf(el) {
    if (!el || el.nodeType !== 1) return 'element';
    if (el.hasAttribute('data-graphein-spec')) return 'chart';
    var tag = el.tagName.toLowerCase(), aria = (el.getAttribute('role') || '').toLowerCase();
    if (tag === 'button' || aria === 'button' || aria === 'tab' || aria === 'menuitem' || (tag === 'input' && /^(button|submit|reset)$/.test(el.type))) return 'button';
    if (tag === 'a' || aria === 'link') {
      var cs = getComputedStyle(el);
      return (!isTransparent(cs.backgroundColor) || parseFloat(cs.borderTopWidth) > 0) && parseFloat(cs.paddingLeft) >= 8 ? 'button' : 'link';
    }
    if (/^h[1-6]$/.test(tag) || aria === 'heading') return 'heading';
    if (/^(img|picture|video|canvas)$/.test(tag) || aria === 'img') return 'image';
    if (tag === 'svg') return 'icon';
    if (/^(input|select|textarea)$/.test(tag) || aria === 'textbox' || aria === 'combobox') return 'field';
    if (tag === 'ul' || tag === 'ol' || aria === 'list') return 'list';
    if (tag === 'li' || aria === 'listitem') return 'item';
    if (/^(table|thead|tbody|tr|td|th)$/.test(tag) || aria === 'table' || aria === 'grid') return 'table';
    if (tag === 'nav' || aria === 'navigation') return 'nav';
    if (tag === 'header' || aria === 'banner') return 'header';
    if (tag === 'footer' || aria === 'contentinfo') return 'footer';
    if (/^(section|main|aside|article|form)$/.test(tag) || aria === 'region' || aria === 'dialog') return 'section';
    if (TEXT_TAGS.test(tag)) return 'text';
    var style = getComputedStyle(el);
    if (looksLikeCard(el, style)) return 'card';
    if (ownText(el) && el.children.length <= 2) return 'text';
    return el.children.length ? 'container' : 'element';
  }

  function chartTitle(spec) {
    if (!spec) return '';
    return typeof spec.title === 'string' ? spec.title : (spec.title && spec.title.text) || '';
  }

  function nameOf(el, role) {
    var aria = el.getAttribute('aria-label');
    if (aria) return clip(aria, 36);
    if (role === 'chart') { var spec = readSpec(el); return clip(chartTitle(spec) || (spec && spec.type) || '', 36); }
    if (role === 'image') return clip(el.getAttribute('alt') || el.getAttribute('title') || '', 36);
    if (role === 'field') {
      var id = el.getAttribute('id'), label = null;
      try { if (id) label = document.querySelector('label[for="' + cssEscape(id) + '"]'); } catch (e) {}
      return clip(el.getAttribute('placeholder') || (label && label.textContent) || el.getAttribute('name') || '', 36);
    }
    if (/^(card|section|container|nav|header|footer|list|table)$/.test(role)) {
      var heading = el.querySelector('h1,h2,h3,h4,h5,h6');
      return clip(heading ? readableText(heading) : firstText(el), 36);
    }
    return clip(ownText(el) || readableText(el), 36);
  }
  function labelOf(el) {
    var role = roleOf(el), name = nameOf(el, role);
    return (ROLE_NAMES[role] || 'Element') + (name ? ' · ' + name : '');
  }

  /** Normalize what the pointer is over into the element a person means. */
  function pick(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el || isOurs(el)) return null;
    var chart = chartRoot(el);
    if (chart) return chart;
    while (el && el.namespaceURI === SVGNS && el.tagName.toLowerCase() !== 'svg') el = el.parentElement;
    if (!el) return null;
    var tag = el.tagName.toLowerCase();
    if (/^(svg|span|img|strong|em|b|i|small)$/.test(tag)) {
      var control = el.closest('button,a,[role="button"]');
      if (control && control !== el) el = control;
    }
    if (el === document.documentElement || el === document.body) return null;
    return el;
  }

  /** Serializable description of `el` (see `DesignTarget`). */
  function describe(el) {
    var role = roleOf(el), r = el.getBoundingClientRect();
    var target = {
      label: labelOf(el),
      role: role,
      tag: el.tagName.toLowerCase(),
      selector: cssPath(el),
      route: route(),
      box: { w: Math.round(r.width), h: Math.round(r.height) }
    };
    var text = role === 'chart' ? '' : elementText(el);
    if (text) target.text = text;
    var classes = (el.getAttribute('class') || '').trim();
    if (classes) target.classes = clip(classes, 600);
    var comp = componentHint(el);
    if (comp) target.component = comp;
    var aria = el.getAttribute('aria-label');
    if (aria) target.ariaLabel = clip(aria, 80);
    var heading = nearestHeading(el);
    if (heading) target.nearestHeading = heading;
    var region = landmark(el);
    if (region) target.region = region;
    if (role === 'chart') {
      var spec = readSpec(el);
      target.chart = { type: (spec && spec.type) || el.getAttribute('data-graphein-type') || undefined, title: chartTitle(spec) || undefined };
    }
    var data = dataAttrs(el);
    if (data) target.dataAttrs = data;
    return target;
  }

  // ---- color math ------------------------------------------------------------
  // Parse the colors computed styles report (rgb/rgba, hex, oklch) into sRGB.
  function parseColor(c) {
    if (!c) return null;
    c = String(c).trim().toLowerCase();
    var m;
    if ((m = c.match(/^#([0-9a-f]{3,8})$/))) {
      var hex = m[1];
      if (hex.length <= 4) hex = hex.split('').map(function (x) { return x + x; }).join('');
      return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1 };
    }
    if ((m = c.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/))) {
      var a = m[4] == null ? 1 : (m[4].slice(-1) === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
      return { r: +m[1], g: +m[2], b: +m[3], a: a };
    }
    if ((m = c.match(/^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?(?:\s*\/\s*([\d.]+%?))?\s*\)$/))) {
      var L = m[1].slice(-1) === '%' ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
      var rgb = oklchToRgb(L, parseFloat(m[2]), parseFloat(m[3]));
      rgb.a = m[4] == null ? 1 : (m[4].slice(-1) === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
      return rgb;
    }
    return null;
  }
  function toLinear(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function fromLinear(v) { var s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; return Math.round(clamp(s, 0, 1) * 255); }
  function oklchToRgb(L, C, H) {
    var hr = H * Math.PI / 180, a = C * Math.cos(hr), b = C * Math.sin(hr);
    var l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    var m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    var s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    return {
      r: fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      g: fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      b: fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
    };
  }
  function rgbToOklch(rgb) {
    var r = toLinear(rgb.r), g = toLinear(rgb.g), b = toLinear(rgb.b);
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    var L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    var A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    var B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    var H = Math.atan2(B, A) * 180 / Math.PI;
    return { l: L, c: Math.sqrt(A * A + B * B), h: H < 0 ? H + 360 : H };
  }
  function toHex(rgb) {
    function x(n) { var s = clamp(Math.round(n), 0, 255).toString(16); return s.length === 1 ? '0' + s : s; }
    return '#' + x(rgb.r) + x(rgb.g) + x(rgb.b);
  }
  function luminance(rgb) { return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b); }
  function contrastRatio(a, b) {
    var la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  /** The color painted behind `el` (the first mostly-opaque ancestor fill); `null` over images/gradients. */
  function effectiveBackground(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      var c = parseColor(cs.backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  // ---- Tailwind vocabulary ---------------------------------------------------
  // Tweaks are recorded in the app's own utilities when it uses them (the
  // deployed DOM keeps Tailwind class names), with Tailwind v4's default scale
  // as the preview fallback when a token isn't defined by the page.
  var TEXT_SCALE = [['xs', 0.75, 1], ['sm', 0.875, 1.25], ['base', 1, 1.5], ['lg', 1.125, 1.75], ['xl', 1.25, 1.75], ['2xl', 1.5, 2], ['3xl', 1.875, 2.25], ['4xl', 2.25, 2.5], ['5xl', 3, 0], ['6xl', 3.75, 0], ['7xl', 4.5, 0], ['8xl', 6, 0], ['9xl', 8, 0]];
  var WEIGHTS = [['light', 300, 'Light'], ['normal', 400, 'Regular'], ['medium', 500, 'Medium'], ['semibold', 600, 'Semibold'], ['bold', 700, 'Bold'], ['extrabold', 800, 'Extra bold']];
  var SPACE_SCALE = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24];
  var RADII = [['none', '0px', 'Square'], ['md', '0.375rem', 'Soft'], ['xl', '0.75rem', 'Round'], ['3xl', '1.5rem', 'Extra'], ['full', '9999px', 'Pill']];
  var SHADOWS = [
    ['none', 'none', 'None'],
    ['sm', '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)', 'Soft'],
    ['md', '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)', 'Medium'],
    ['lg', '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)', 'Strong'],
    ['xl', '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)', 'Lifted']
  ];
  var SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];
  var SWATCH_SHADES = ['100', '200', '300', '400', '500', '600', '700', '800', '900'];
  var NEUTRALS = ['slate', 'gray', 'zinc', 'neutral', 'stone'];
  // Hue (OKLCH degrees) and peak chroma of Tailwind's named palettes; used to
  // synthesize a ramp when the page doesn't define that palette's variables.
  var HUES = {
    red: [25, 0.23], orange: [48, 0.2], amber: [72, 0.18], yellow: [95, 0.18], lime: [128, 0.2], green: [150, 0.19],
    emerald: [163, 0.16], teal: [182, 0.13], cyan: [212, 0.14], sky: [237, 0.16], blue: [260, 0.21], indigo: [277, 0.22],
    violet: [293, 0.24], purple: [303, 0.25], fuchsia: [322, 0.26], pink: [354, 0.21], rose: [12, 0.22],
    slate: [257, 0.04], gray: [264, 0.03], zinc: [286, 0.015], neutral: [0, 0], stone: [56, 0.012]
  };
  var RAMP_L = { '50': 0.975, '100': 0.94, '200': 0.89, '300': 0.81, '400': 0.71, '500': 0.62, '600': 0.54, '700': 0.47, '800': 0.4, '900': 0.35, '950': 0.26 };
  var RAMP_C = { '50': 0.08, '100': 0.18, '200': 0.35, '300': 0.6, '400': 0.84, '500': 1, '600': 1, '700': 0.9, '800': 0.76, '900': 0.64, '950': 0.5 };

  function tokensOf(el) { return (el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  /** The first un-prefixed (no `hover:` / `md:` …) utility matching `re`. */
  function baseToken(el, re) {
    var tokens = tokensOf(el);
    for (var i = 0; i < tokens.length; i++) if (tokens[i].indexOf(':') < 0 && re.test(tokens[i])) return tokens[i];
    return null;
  }
  function hasVariantOf(el, re) {
    return tokensOf(el).some(function (t) { var i = t.lastIndexOf(':'); return i > 0 && re.test(t.slice(i + 1)); });
  }
  function rampValue(hue, chroma, shade) {
    var L = RAMP_L[shade], C = chroma * RAMP_C[shade];
    return 'oklch(' + L.toFixed(3) + ' ' + C.toFixed(3) + ' ' + hue.toFixed(1) + ')';
  }
  function paletteFallback(name, shade) {
    var hc = HUES[name];
    return hc ? rampValue(hc[0], hc[1], shade) : 'currentColor';
  }
  /** Preview value for a palette shade: the page's own variable, else a close synthesis. */
  function paletteVar(name, shade) {
    if (name === 'white') return '#ffffff';
    if (name === 'black') return '#000000';
    return 'var(--color-' + name + '-' + shade + ', ' + paletteFallback(name, shade) + ')';
  }
  function colorToken(el, prefix) {
    return baseToken(el, new RegExp('^' + prefix + '-((?:[a-z]+)-(?:50|100|200|300|400|500|600|700|800|900|950)(?:\\/\\d+)?|white|black|transparent)$'));
  }
  function textSizeIndex(el) {
    var tok = baseToken(el, /^text-(xs|sm|base|lg|xl|[2-9]xl)$/);
    if (tok) { var name = tok.slice(5); for (var i = 0; i < TEXT_SCALE.length; i++) if (TEXT_SCALE[i][0] === name) return { index: i, token: tok }; }
    var px = parseFloat(getComputedStyle(el).fontSize) || 16, best = 0;
    for (var j = 0; j < TEXT_SCALE.length; j++) if (Math.abs(TEXT_SCALE[j][1] * 16 - px) < Math.abs(TEXT_SCALE[best][1] * 16 - px)) best = j;
    return { index: best, token: null, px: px };
  }
  function nearestSpace(px) {
    var steps = px / 4, best = 0;
    for (var i = 0; i < SPACE_SCALE.length; i++) if (Math.abs(SPACE_SCALE[i] - steps) < Math.abs(SPACE_SCALE[best] - steps)) best = i;
    return best;
  }
  function spaceIndex(value) {
    var n = value === 'px' ? 0.25 : parseFloat(value), best = 0;
    for (var i = 0; i < SPACE_SCALE.length; i++) if (Math.abs(SPACE_SCALE[i] - n) < Math.abs(SPACE_SCALE[best] - n)) best = i;
    return best;
  }
  function spaceCss(steps) { return steps === 0 ? '0px' : 'calc(var(--spacing, 0.25rem) * ' + steps + ')'; }
  function spaceToken(prefix, steps) { return prefix + '-' + String(steps); }

  // ---- Graphein charts + smart type conversion -------------------------------
  function readSpec(chartEl) { try { return JSON.parse(chartEl.getAttribute('data-graphein-spec') || 'null'); } catch (e) { return null; } }
  function writeSpec(chartEl, spec) { try { chartEl.setAttribute('data-graphein-spec', JSON.stringify(spec)); } catch (e) {} }
  function stripData(spec) {
    if (!spec || typeof spec !== 'object') return spec;
    var c = {};
    for (var k in spec) if (k !== 'data') c[k] = spec[k];
    if (JSON.stringify(c).length > MAX_SPEC_BYTES) { var small = {}; ['type', 'title', 'palette', 'legend', 'sort', 'orientation', 'encoding'].forEach(function (key) { if (c[key] !== undefined) small[key] = c[key]; }); return small; }
    return c;
  }

  // Every Graphein VISUAL chart type (the slicer controls are filters, not marks).
  var CHART_TYPES = ['bar', 'line', 'area', 'scatter', 'combo', 'histogram', 'pie', 'heatmap', 'funnel', 'treemap', 'waterfall', 'box', 'slope', 'dumbbell', 'sankey', 'choropleth', 'calendarHeatmap', 'kpi', 'gauge', 'bullet', 'table', 'matrix'];
  var TYPE_GROUPS = [
    ['Cartesian', ['bar', 'line', 'area', 'scatter', 'box', 'histogram', 'combo']],
    ['Part-to-whole', ['pie', 'funnel', 'treemap', 'waterfall']],
    ['Comparison', ['slope', 'dumbbell']],
    ['Grid / time', ['heatmap', 'calendarHeatmap']],
    ['Flow / geo', ['sankey', 'choropleth']],
    ['Single value', ['kpi', 'gauge', 'bullet']],
    ['Tabular', ['table', 'matrix']]
  ];
  var TYPE_LABELS = { calendarHeatmap: 'Calendar heatmap', kpi: 'KPI' };
  function typeLabel(t) { return TYPE_LABELS[t] || (t.charAt(0).toUpperCase() + t.slice(1)); }
  var PALETTES = ['graphein', 'colorblind', 'bright', 'muted'];
  var FORMATS = [['', 'Default'], [',.0f', '1,234'], [',.2f', '1,234.56'], ['$,.0f', '$1,234'], ['.1%', '12.3%'], ['.2s', '1.2k']];
  // BaseSpec-level props safe to carry across a type change (structural /
  // encoding props are rebuilt from the normalized shape).
  var CONVERT_CARRY = ['data', 'transform', 'theme', 'palette', 'title', 'description', 'legend', 'tooltip', 'animation', 'padding', 'background', 'sketch', 'dimensions', 'params', 'highlight', 'filter'];

  function asField(v) {
    if (v == null) return null;
    if (typeof v === 'string') return { field: v };
    if (typeof v === 'object' && v.field) return { field: v.field, type: v.type, aggregate: v.aggregate, title: v.title };
    return null;
  }
  function isMeasureField(f) { return !!(f && (f.type === 'quantitative' || f.aggregate)); }
  function isTemporalField(f) { return !!(f && f.type === 'temporal'); }

  // Normalize any chart spec into abstract roles used for convertibility + remap.
  function shapeOf(spec) {
    var t = spec && spec.type;
    var enc = (spec && spec.encoding) || {};
    var dims = [], measures = [], roles = {};
    function dim(f) { if (f) dims.push(f); }
    function meas(f) { if (f) measures.push(f); }
    var x = asField(enc.x), y = asField(enc.y), color = asField(enc.color), series = asField(enc.series),
      theta = asField(enc.theta), value = asField(enc.value), stage = asField(enc.stage),
      source = asField(enc.source), target = asField(enc.target), key = asField(enc.key),
      size = asField(enc.size), category = asField(enc.category), group = asField(enc.group),
      date = asField(enc.date);
    switch (t) {
      case 'bar': case 'line': case 'area': case 'box':
        dim(x); meas(y);
        if (series) { roles.series = series; dim(series); }
        if (isTemporalField(x)) roles.date = x;
        break;
      case 'scatter':
        if (isMeasureField(x)) meas(x); else dim(x);
        meas(y); if (size) meas(size);
        if (isTemporalField(x)) roles.date = x;
        break;
      case 'histogram':
        meas(x || y);
        break;
      case 'combo':
        dim(x); if (isTemporalField(x)) roles.date = x;
        var layers = spec.layers || [];
        for (var li = 0; li < layers.length; li++) { var ly = asField(layers[li] && layers[li].encoding && layers[li].encoding.y); if (ly) meas(ly); }
        break;
      case 'pie':
        dim(color); meas(theta);
        break;
      case 'heatmap':
        dim(x); dim(y); meas(color);
        break;
      case 'funnel': case 'waterfall':
        dim(stage || x); meas(value || y);
        break;
      case 'treemap':
        dim(category || color); meas(value || theta);
        if (group) { roles.group = group; dim(group); }
        break;
      case 'slope':
        dim(x); meas(y); if (series) { roles.series = series; dim(series); }
        break;
      case 'dumbbell':
        dim(category || x); meas(value || y);
        if (group) { roles.group = group; dim(group); }
        break;
      case 'sankey':
        if (source) { roles.source = source; dim(source); }
        if (target) { roles.target = target; dim(target); }
        meas(value);
        break;
      case 'choropleth':
        if (key) { roles.geoKey = key; dim(key); }
        meas(color);
        roles.hasGeo = !!spec.geo;
        break;
      case 'calendarHeatmap':
        if (date) { roles.date = date; dim(date); }
        meas(color || value);
        break;
      case 'kpi': case 'gauge': case 'bullet':
        meas(asField(spec.value) || value || y);
        break;
      case 'table':
        var cols = spec.columns || [];
        for (var ci = 0; ci < cols.length; ci++) { var cf = asField(cols[ci]); if (!cf) continue; if (isMeasureField(cf)) meas(cf); else dim(cf); }
        break;
      case 'matrix':
        var rws = spec.rows || [];
        for (var ri = 0; ri < rws.length; ri++) dim(asField(rws[ri]));
        var vals = spec.values || [];
        for (var vi = 0; vi < vals.length; vi++) { var vv = vals[vi]; if (vv && vv.field) meas({ field: vv.field, aggregate: vv.op }); }
        break;
      default:
        dim(x); meas(y || value || theta);
    }
    dims = dims.filter(Boolean); measures = measures.filter(Boolean);
    return {
      type: t, dims: dims, measures: measures, roles: roles,
      dimCount: dims.length, measCount: measures.length,
      series: roles.series || null, group: roles.group || null,
      source: roles.source || null, target: roles.target || null,
      geoKey: roles.geoKey || null, date: roles.date || null, hasGeo: !!roles.hasGeo
    };
  }

  // Can `shape` become `target`? → { ok:true } or { ok:false, reason:'…' }.
  function canConvert(shape, target) {
    if (!shape || !target) return { ok: false, reason: '' };
    if (target === shape.type) return { ok: true };
    var d = shape.dimCount, m = shape.measCount;
    function need(cond, reason) { return cond ? { ok: true } : { ok: false, reason: reason }; }
    switch (target) {
      case 'bar': case 'line': case 'area': case 'box':
        return need(d >= 1 && m >= 1, 'needs a category and a value');
      case 'scatter':
        return need(m >= 1 && (d + m) >= 2, 'needs two numeric fields');
      case 'histogram':
        return need(m >= 1, 'needs a numeric field');
      case 'combo':
        return need(d >= 1 && m >= 1, 'needs a category and a value');
      case 'pie': case 'funnel': case 'waterfall': case 'treemap':
        return need(d >= 1 && m >= 1, 'needs a category and a value');
      case 'heatmap':
        return need(d >= 2 && m >= 1, 'needs two categories and a value');
      case 'slope':
        return need(m >= 1 && (!!shape.series || d >= 2), 'needs a series (or two categories)');
      case 'dumbbell':
        return need(m >= 1 && (!!shape.group || d >= 2), 'needs a group (or two categories)');
      case 'sankey':
        return need(m >= 1 && ((!!shape.source && !!shape.target) || d >= 2), 'needs source & target');
      case 'choropleth':
        return need(!!shape.hasGeo, 'needs map geometry');
      case 'calendarHeatmap':
        return need(m >= 1 && !!shape.date, 'needs a date field');
      case 'kpi': case 'gauge': case 'bullet':
        return need(m >= 1, 'needs a numeric value');
      case 'table':
        return need((d + m) >= 1, 'needs at least one field');
      case 'matrix':
        return need(d >= 1 && m >= 1, 'needs a category and a value');
    }
    return { ok: true };
  }

  // A sensible full-scale for a gauge from the data (gauge requires `max`).
  function gaugeMax(spec, field) {
    var data = spec && spec.data;
    if (Array.isArray(data) && field) {
      var mx = null;
      for (var i = 0; i < data.length; i++) { var v = +(data[i] && data[i][field]); if (!isNaN(v)) mx = (mx == null ? v : Math.max(mx, v)); }
      if (mx != null && mx > 0) { var mag = Math.pow(10, Math.floor(Math.log(mx) / Math.LN10)); return Math.ceil((mx * 1.1) / mag) * mag; }
    }
    return 100;
  }

  // A NEW spec of `target` type, remapping the source's roles into the target's
  // channel names. Pure (no mutation) so it's unit-testable.
  function convertSpec(spec, target) {
    var shape = shapeOf(spec);
    var out = {};
    for (var i = 0; i < CONVERT_CARRY.length; i++) { var k = CONVERT_CARRY[i]; if (spec[k] !== undefined) out[k] = cloneVal(spec[k]); }
    out.type = target;
    var dim0 = shape.dims[0], dim1 = shape.dims[1], meas0 = shape.measures[0], meas1 = shape.measures[1];
    var cat = dim0 ? dim0.field : (meas0 ? meas0.field : 'category');
    var cat2 = dim1 ? dim1.field : null;
    var measure = meas0 ? meas0.field : (dim0 ? dim0.field : 'value');
    var measure2 = meas1 ? meas1.field : null;
    var agg = (meas0 && meas0.aggregate) || 'sum';
    function F(field) { return { field: field }; }
    switch (target) {
      case 'bar': case 'line': case 'area': case 'box':
        out.encoding = { x: F(cat), y: F(measure) };
        if (shape.series) out.encoding.series = F(shape.series.field);
        break;
      case 'scatter':
        out.encoding = { x: F(measure2 || cat), y: F(measure) };
        break;
      case 'histogram':
        out.encoding = { x: F(measure) };
        break;
      case 'combo':
        out.encoding = { x: F(cat) };
        out.layers = [{ mark: 'bar', encoding: { y: F(measure) } }];
        if (measure2) out.layers.push({ mark: 'line', encoding: { y: F(measure2) }, axis: 'right' });
        break;
      case 'pie':
        out.encoding = { theta: F(measure), color: F(cat) };
        break;
      case 'funnel': case 'waterfall':
        out.encoding = { stage: F(cat), value: F(measure) };
        break;
      case 'treemap':
        out.encoding = { category: F(cat), value: F(measure) };
        if (shape.group) out.encoding.group = F(shape.group.field); else if (cat2) out.encoding.group = F(cat2);
        break;
      case 'heatmap':
        out.encoding = { x: F(cat), y: F(cat2 || cat), color: F(measure) };
        break;
      case 'slope':
        out.encoding = { x: F(cat), y: F(measure), series: F((shape.series && shape.series.field) || cat2 || cat) };
        break;
      case 'dumbbell':
        out.encoding = { category: F(cat), value: F(measure), group: F((shape.group && shape.group.field) || cat2 || cat) };
        break;
      case 'sankey':
        out.encoding = { source: F((shape.source && shape.source.field) || cat), target: F((shape.target && shape.target.field) || cat2 || cat), value: F(measure) };
        break;
      case 'choropleth':
        out.encoding = { key: F((shape.geoKey && shape.geoKey.field) || cat), color: F(measure) };
        if (spec.geo) out.geo = cloneVal(spec.geo);
        if (spec.featureId) out.featureId = spec.featureId;
        if (spec.projection) out.projection = spec.projection;
        break;
      case 'calendarHeatmap':
        out.encoding = { date: F((shape.date && shape.date.field) || cat), color: F(measure) };
        break;
      case 'kpi':
        out.value = { field: measure, aggregate: agg };
        if (meas0 && meas0.title) out.label = meas0.title;
        break;
      case 'gauge':
        out.value = { field: measure, aggregate: agg };
        out.max = gaugeMax(spec, measure);
        break;
      case 'bullet':
        out.value = { field: measure, aggregate: agg };
        break;
      case 'table':
        var tcols = shape.dims.concat(shape.measures).map(function (f) { var c = { field: f.field }; if (f.title) c.title = f.title; return c; });
        if (tcols.length) out.columns = tcols;
        break;
      case 'matrix':
        out.rows = [cat];
        out.values = [{ field: measure, op: agg }];
        if (cat2) out.columns = [cat2];
        break;
    }
    return out;
  }

  /** Human "before → after" lines for a chart spec change (data stripped). */
  function chartSummary(before, after) {
    var lines = [];
    function show(v) { return typeof v === 'string' ? v : JSON.stringify(v); }
    var keys = {};
    Object.keys(before || {}).concat(Object.keys(after || {})).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      if (k === 'data') return;
      var a = before ? before[k] : undefined, b = after ? after[k] : undefined;
      if (JSON.stringify(a) === JSON.stringify(b)) return;
      if (k === 'title') lines.push('title → “' + clip(chartTitle(after), 60) + '”');
      else if (k === 'type') lines.push('type: ' + (a || '?') + ' → ' + b);
      else if (k === 'encoding' && before && after && before.type !== after.type) return;
      else if (b === undefined) lines.push(k + ' removed');
      else lines.push(k + ' → ' + clip(show(b), 80));
    });
    return lines;
  }

  // ---- theme tokens -----------------------------------------------------------
  // Tailwind v4 compiles utilities to CSS variables (`var(--color-indigo-600)`,
  // `calc(var(--spacing) * 4)`, `var(--radius-xl)`), so overriding those on
  // :root previews an app-wide theme instantly, deployed or local.
  var FONTS = [
    ['', 'Current'],
    ['ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', 'System'],
    ['Avenir, Montserrat, Corbel, "URW Gothic", source-sans-pro, sans-serif', 'Geometric'],
    ['Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif', 'Humanist'],
    ['ui-rounded, "Hiragino Maru Gothic ProN", Quicksand, Comfortaa, Manjari, "Arial Rounded MT", Calibri, sans-serif', 'Rounded'],
    ['Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif', 'Serif'],
    ['ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace', 'Mono']
  ];
  var RADIUS_SCALES = [[0, 'Sharp'], [0.5, 'Subtle'], [1, 'Default'], [1.6, 'Round'], [2.4, 'Extra']];
  var DENSITIES = [['0.22rem', 'Compact'], ['', 'Default'], ['0.28rem', 'Spacious']];
  var INTENTS = ['Warmer and friendlier', 'Clean and minimal', 'Bold with high contrast', 'Softer and rounder', 'Match the Microsoft Fabric look'];

  function walkRules(list, visit) {
    for (var i = 0; list && i < list.length; i++) {
      var rule = list[i];
      try {
        visit(rule);
        if (rule.cssRules && rule.cssRules.length) walkRules(rule.cssRules, visit);
      } catch (e) {}
    }
  }
  /** Every custom property declared on :root / :host / html, plus whether `.dark` rules exist. */
  function readThemeVars() {
    var vars = {}, dark = false;
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      var sheet = sheets[i], rules = null;
      if (sheet.ownerNode && sheet.ownerNode.id === THEME_STYLE_ID) continue;
      try { rules = sheet.cssRules; } catch (e) { continue; } // cross-origin sheet
      walkRules(rules, function (rule) {
        var sel = rule.selectorText;
        if (!sel || !rule.style) return;
        if (!dark && /\.dark\b/.test(sel)) dark = true;
        if (!/(^|,)\s*(:root|:host|html)\s*(,|$)/.test(sel)) return;
        for (var j = 0; j < rule.style.length; j++) {
          var p = rule.style[j];
          if (p.indexOf('--') === 0 && vars[p] === undefined) vars[p] = rule.style.getPropertyValue(p).trim();
        }
      });
    }
    return { vars: vars, dark: dark };
  }

  var PALETTE_USE_RE = /(?:^|:)(?:bg|text|border|ring|outline|fill|stroke|from|via|to|decoration|accent|caret|divide|placeholder|shadow)-([a-z]+)-(50|100|200|300|400|500|600|700|800|900|950)(?:\/\d+)?$/;

  /** What the page's theme is made of: Tailwind tokens, palettes in use (by class usage), radii, spacing, font. */
  function detectTheme() {
    var found = readThemeVars(), vars = found.vars;
    var usage = {}, seen = 0;
    var all = document.body ? document.body.getElementsByTagName('*') : [];
    for (var i = 0; i < all.length && seen < 5000; i++, seen++) {
      var cls = all[i].getAttribute && all[i].getAttribute('class');
      if (!cls || typeof cls !== 'string') continue;
      var tokens = cls.split(/\s+/);
      for (var j = 0; j < tokens.length; j++) {
        var m = tokens[j].match(PALETTE_USE_RE);
        if (m && HUES[m[1]]) usage[m[1]] = (usage[m[1]] || 0) + 1;
      }
    }
    var ranked = Object.keys(usage).sort(function (a, b) { return usage[b] - usage[a]; });
    var neutral = ranked.filter(function (p) { return NEUTRALS.indexOf(p) >= 0; })[0] || null;
    var accents = ranked.filter(function (p) { return NEUTRALS.indexOf(p) < 0; });
    var radii = {};
    Object.keys(vars).forEach(function (k) { if (/^--radius-/.test(k)) radii[k] = vars[k]; });
    var tailwind = vars['--spacing'] !== undefined || Object.keys(vars).some(function (k) { return /^--color-[a-z]+-\d{2,3}$/.test(k); }) || ranked.length > 0;
    return {
      tailwind: tailwind,
      vars: vars,
      usage: usage,
      accent: accents[0] || null,
      accents: accents.slice(0, 3),
      neutral: neutral,
      radii: radii,
      spacing: vars['--spacing'] || (tailwind ? '0.25rem' : null),
      font: vars['--font-sans'] || null,
      dark: found.dark
    };
  }

  function scaleLength(value, factor) {
    var m = String(value).trim().match(/^(-?[\d.]+)(rem|px|em)$/);
    if (!m) return null;
    var n = parseFloat(m[1]) * factor;
    return (Math.round(n * 1000) / 1000) + m[2];
  }
  function remapPalette(tokens, from, to, detected, hexHue) {
    SHADES.forEach(function (shade) {
      var name = '--color-' + from + '-' + shade;
      var own = to && detected.vars['--color-' + to + '-' + shade];
      tokens[name] = hexHue ? rampValue(hexHue.h, Math.max(hexHue.c, 0.02), shade) : (own || paletteFallback(to, shade));
    });
  }
  /** The exact custom-property overrides for a theme change (`DesignThemeChange.tokens`). */
  function themeTokens(change, detected) {
    var tokens = {};
    if (change.accent && change.accent.from) {
      var hexHue = change.accent.hex ? rgbToOklch(parseColor(change.accent.hex) || { r: 0, g: 0, b: 0 }) : null;
      if (hexHue || change.accent.to !== change.accent.from) remapPalette(tokens, change.accent.from, change.accent.to, detected, hexHue);
    }
    if (change.neutral && change.neutral.from && change.neutral.to !== change.neutral.from) remapPalette(tokens, change.neutral.from, change.neutral.to, detected, null);
    if (change.radius && change.radius.scale !== 1) {
      var radii = Object.keys(detected.radii).length ? detected.radii : { '--radius-sm': '0.25rem', '--radius-md': '0.375rem', '--radius-lg': '0.5rem', '--radius-xl': '0.75rem', '--radius-2xl': '1rem', '--radius-3xl': '1.5rem' };
      Object.keys(radii).forEach(function (k) { var v = scaleLength(radii[k], change.radius.scale); if (v) tokens[k] = v; });
    }
    if (change.density && change.density.to) tokens['--spacing'] = change.density.to;
    if (change.font && change.font.stack) tokens['--font-sans'] = change.font.stack;
    return tokens;
  }
  function themeSummary(change) {
    var s = [];
    if (change.accent) s.push('Accent: ' + (change.accent.from || '?') + ' → ' + (change.accent.hex || change.accent.to));
    if (change.neutral) s.push('Neutral: ' + change.neutral.from + ' → ' + change.neutral.to);
    if (change.radius) s.push('Corners: ×' + change.radius.scale);
    if (change.density) s.push('Density: --spacing ' + change.density.from + ' → ' + change.density.to);
    if (change.font) s.push('Font: ' + change.font.to);
    if (change.intent) s.push('Look: ' + change.intent);
    return s;
  }
  function themeCss(tokens) {
    var decls = Object.keys(tokens).filter(function (k) {
      return /^--[a-z0-9-]+$/i.test(k) && typeof tokens[k] === 'string' && !UNSAFE_VALUE.test(tokens[k]);
    }).map(function (k) { return k + ':' + tokens[k]; }).join(';');
    var css = decls ? ':root{' + decls + '}' : '';
    if (tokens['--font-sans']) css += 'html,body{font-family:var(--font-sans)}';
    return css;
  }

  // ---- state -----------------------------------------------------------------
  var state = {
    enabled: false,
    sessionId: null,
    version: 0,
    items: [],          // serializable DesignItems (+ `_undo` history, stripped on the wire)
    hover: null,
    selected: null,     // { el, key, itemId, similar: [els], tool, options, pendingRequest }
    requests: [],
    results: {},
    resultTimes: {},
    panel: null,        // 'theme' | 'polish' | null
    panelSide: 'right', // which edge the Theme / Polish sheet docks to
    busy: null,
    busySince: 0,
    hostTheme: null,
    hasTheme: false,
    detected: null,
    darkPreview: null,  // original `dark` class state while previewing the other mode
    suggestions: [],
    suggestionMessage: '',
    previews: {},       // suggestion id -> temporary projection
    capturing: false,
    intro: false,
    lastItemId: null,
    lastRoute: ''
  };
  var proj = {};         // item id -> { el, els } (where the item's preview goes)
  var outlineRefs = {};  // Polish outline ref -> element
  var requestTimes = {}; // pending request id -> created (ms)

  function bump() { state.version++; scheduleSync(); }
  function itemById(id) { for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i]; return null; }
  function itemIndex(id) { for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return i; return -1; }
  function itemForElement(el) {
    for (var id in proj) if (proj[id].el === el) return itemById(id);
    return null;
  }
  function serializeItem(item) {
    var out = {};
    for (var k in item) if (k.charAt(0) !== '_' && item[k] !== undefined) out[k] = item[k];
    return cloneVal(out);
  }
  function hasContent(item) {
    return Boolean((item.instruction && item.instruction.trim()) || (item.tweaks && item.tweaks.length) || item.chart || (item.theme && (Object.keys(item.theme.tokens || {}).length || item.theme.intent)));
  }
  function pushUndo(item) {
    item._undo = item._undo || [];
    item._undo.push(JSON.stringify({ instruction: item.instruction, tweaks: item.tweaks, chart: item.chart, similar: item.similar, theme: item.theme }));
    if (item._undo.length > 40) item._undo.shift();
  }
  function newElementItem(el, kind) {
    var item = { id: uid('i'), kind: kind || 'element', target: describe(el), tweaks: [], createdAt: Date.now() };
    state.items.push(item);
    proj[item.id] = { el: el, els: [el] };
    return item;
  }

  // ---- projection: previews are disposable overlays on the live app ----------
  // Every preview — queued items, Polish previews and the hovered choice — is
  // composed onto each node's ORIGINAL value, recorded the first time any preview
  // touches the node. Overlapping previews (a move re-orders every sibling, "all
  // like this", two changes on one element) therefore stack and restore correctly
  // whichever one changes or goes away. Only differences are written to the page.
  var touched = new Map(); // node -> { style?, spec?, text? }, each { orig, wrote[, props] }
  var textCount = 0;       // text-node records in `touched`
  var pass = null;         // node -> { style: [[prop, value]…], spec?, text? } while composing
  var hoverProj = null;    // the hovered choice: { hyp, el, els, replaces }
  var scratch = null;

  function want(node) {
    var w = pass.get(node);
    if (!w) { w = { style: [] }; pass.set(node, w); }
    return w;
  }
  function setStyle(node, prop, value) { if (pass && node) want(node).style.push([prop, value]); }
  function applyRules(node, rules) {
    (rules || []).forEach(function (rule) {
      var targets;
      try { targets = node.querySelectorAll(rule.selector); } catch (e) { return; }
      for (var i = 0; i < targets.length && i < 60; i++) {
        if (isOurs(targets[i])) continue;
        for (var prop in rule.styles) setStyle(targets[i], prop, rule.styles[prop]);
      }
    });
  }
  /** A text node's value before any preview touched it. */
  function origText(n) { var r = textCount && touched.get(n); return r && r.text ? r.text.orig : n.nodeValue; }
  function origOwnText(el) {
    var s = '';
    for (var i = 0; el && i < el.childNodes.length; i++) if (el.childNodes[i].nodeType === 3) s += origText(el.childNodes[i]);
    return s.replace(/\s+/g, ' ').trim();
  }
  function origTextContent(el) {
    if (!textCount) return el.textContent || '';
    var s = '', walker = document.createTreeWalker(el, 4 /* SHOW_TEXT */, null), n;
    while ((n = walker.nextNode())) s += origText(n);
    return s;
  }
  /** The element whose own text nodes hold `el`'s label (itself, or a lone descendant). */
  function textHost(el) {
    var n = el;
    for (var hop = 0; n && hop < 4; hop++) {
      if (origOwnText(n)) return n;
      var kids = Array.prototype.filter.call(n.children, function (c) { return origTextContent(c).trim(); });
      if (kids.length !== 1) return null;
      n = kids[0];
    }
    return null;
  }
  function applyText(el, to) {
    var host = textHost(el);
    if (!host) return;
    var nodes = Array.prototype.filter.call(host.childNodes, function (n) { return n.nodeType === 3 && origText(n).trim(); });
    nodes.forEach(function (n, i) {
      var o = origText(n);
      want(n).text = i === 0 ? o.match(/^\s*/)[0] + to + o.match(/\s*$/)[0] : '';
    });
  }
  function flowParent(el) {
    var parent = el.parentElement;
    if (!parent) return null;
    var d = getComputedStyle(parent).display;
    return /flex|grid/.test(d) ? parent : null;
  }
  /** Preview a reorder with CSS `order` (flex / grid parents only — never moves DOM nodes). */
  function applyOrder(el, steps) {
    var parent = flowParent(el);
    if (!parent || !steps) return;
    var kids = Array.prototype.slice.call(parent.children).filter(function (c) { return !isOurs(c); });
    var from = kids.indexOf(el), to = clamp(from + steps, 0, kids.length - 1);
    kids.splice(from, 1);
    kids.splice(to, 0, el);
    kids.forEach(function (c, i) { setStyle(c, 'order', String(i)); });
  }
  function applyChart(el, change) {
    var spec = readSpec(el);
    if (!spec || !change || !change.after) return;
    var next = { data: spec.data };
    for (var k in change.after) if (k !== 'data') next[k] = cloneVal(change.after[k]);
    if (next.data === undefined) delete next.data;
    want(el).spec = JSON.stringify(next);
  }
  function applyItem(item, p) {
    var el = p.el;
    (item.tweaks || []).forEach(function (t) {
      if (t.kind === 'text' && t.text) { applyText(el, t.text.to); return; }
      if (t.kind === 'order' && t.order) { applyOrder(el, t.order.steps || 0); return; }
      p.els.forEach(function (node) {
        if (!node.isConnected) return;
        (t.css || []).forEach(function (c) { setStyle(node, c.property, c.to); });
        if (t.rules) applyRules(node, t.rules);
      });
    });
    if (item.chart) applyChart(el, item.chart);
  }
  /** Re-render every preview onto the page, writing only what changed. */
  function compose() {
    var next = new Map();
    pass = next;
    var each = function (item, p) { try { applyItem(item, p); } catch (e) {} };
    try {
      var skip = hoverProj ? hoverProj.replaces : null;
      state.items.forEach(function (item) {
        if (item.kind === 'theme' || item.id === skip) return;
        var p = proj[item.id];
        if (p && p.el && p.el.isConnected) each(item, p);
      });
      // Only queued changes belong in a capture.
      if (!state.capturing) {
        for (var id in state.previews) {
          var sp = state.previews[id];
          if (!sp.el.isConnected) continue;
          for (var prop in sp.styles) setStyle(sp.el, prop, sp.styles[prop]);
          applyRules(sp.el, sp.rules);
        }
        if (hoverProj && hoverProj.el.isConnected) each(hoverProj.hyp, hoverProj);
      }
    } finally {
      pass = null;
    }
    touched.forEach(function (rec, node) { if (!next.has(node)) writeNode(node, rec, null); });
    next.forEach(function (w, node) { writeNode(node, touched.get(node) || {}, w); });
  }
  /** Put every node a preview touched back to its original value. */
  function restoreAll() {
    hoverProj = null;
    touched.forEach(function (rec, node) { writeNode(node, rec, null); });
    touched = new Map();
    textCount = 0;
  }
  function writeNode(node, rec, w) {
    writeStyle(node, rec, w && w.style.length ? w.style : null);
    writeValue(node, rec, 'spec', w ? w.spec : undefined);
    writeValue(node, rec, 'text', w ? w.text : undefined);
    if (rec.style || rec.spec || rec.text) touched.set(node, rec); else touched.delete(node);
  }
  function putAttr(node, name, value) {
    try { if (value == null) node.removeAttribute(name); else node.setAttribute(name, value); } catch (e) {}
  }
  function scratchStyle(value) {
    scratch = scratch || document.createElement('div');
    putAttr(scratch, 'style', value);
    return scratch.style;
  }
  function scratchValue(base) {
    var out = scratch.getAttribute('style');
    return out === '' && base == null ? null : out;
  }
  /** A style attribute with `ops` ([property, value] pairs, in order) applied on top. */
  function styleWith(base, ops) {
    var st = scratchStyle(base);
    ops.forEach(function (o) { try { st.setProperty(o[0], o[1]); } catch (e) {} });
    return scratchValue(base);
  }
  /** The app's current inline style with the properties we manage put back to their originals. */
  function rebaseStyle(cur, orig, props) {
    var o = scratchStyle(orig);
    var keep = props.map(function (prop) { return [prop, o.getPropertyValue(prop), o.getPropertyPriority(prop)]; });
    var st = scratchStyle(cur);
    keep.forEach(function (k) { try { if (k[1]) st.setProperty(k[0], k[1], k[2]); else st.removeProperty(k[0]); } catch (e) {} });
    return scratchValue(orig);
  }
  function writeStyle(node, rec, ops) {
    var r = rec.style;
    if (!ops && !r) return;
    var cur = node.getAttribute('style');
    if (ops) {
      if (!r) r = rec.style = { orig: cur, wrote: cur, props: [] };
      // The app rewrote the inline style since our last write: keep its changes.
      else if (cur !== r.wrote) r.orig = rebaseStyle(cur, r.orig, r.props);
      var next = styleWith(r.orig, ops);
      if (cur !== next) putAttr(node, 'style', next);
      r.wrote = next;
      r.props = ops.map(function (o) { return o[0]; });
    } else {
      var back = cur === r.wrote ? r.orig : rebaseStyle(cur, r.orig, r.props);
      if (cur !== back) putAttr(node, 'style', back);
      delete rec.style;
    }
  }
  function readValue(node, kind) { return kind === 'text' ? node.nodeValue : node.getAttribute('data-graphein-spec'); }
  function putValue(node, kind, value) {
    if (kind === 'text') { try { node.nodeValue = value == null ? '' : value; } catch (e) {} }
    else putAttr(node, 'data-graphein-spec', value);
  }
  function writeValue(node, rec, kind, value) {
    var r = rec[kind];
    if (value === undefined && !r) return;
    var cur = readValue(node, kind);
    if (value !== undefined) {
      if (!r) { r = rec[kind] = { orig: cur, wrote: cur }; if (kind === 'text') textCount++; }
      else if (cur !== r.wrote) r.orig = cur; // the app changed it since our last write
      if (cur !== value) putValue(node, kind, value);
      r.wrote = value;
    } else {
      // Put the original back, unless the app replaced the value meanwhile (its value is newer).
      if (cur === r.wrote && cur !== r.orig) putValue(node, kind, r.orig);
      delete rec[kind];
      if (kind === 'text') textCount--;
    }
  }

  function fits(el, t) {
    if (!el || el.tagName.toLowerCase() !== t.tag || isOurs(el)) return false;
    if (!t.text) return true;
    return elementText(el) === t.text;
  }
  /** Find an item's element again (after SPA navigation or a re-render). */
  function anchor(item) {
    var p = proj[item.id];
    if (p && p.el && p.el.isConnected) return p.el;
    var t = item.target;
    if (!t || (t.route && t.route !== route())) return null;
    var el = null;
    try { el = document.querySelector(t.selector); } catch (e) {}
    if (el && fits(el, t)) return el;
    var best = null, bestScore = 0, list = document.getElementsByTagName(t.tag);
    for (var i = 0; i < list.length && i < 4000; i++) {
      var c = list[i];
      if (isOurs(c)) continue;
      var score = 0;
      if (t.classes && (c.getAttribute('class') || '').trim() === t.classes) score += 2;
      if (t.text && elementText(c) === t.text) score += 2;
      if (score > bestScore) { best = c; bestScore = score; }
    }
    return bestScore >= 2 ? best : null;
  }
  function similarOf(el) {
    var cls = (el.getAttribute('class') || '').trim();
    if (!cls) return [];
    var out = [], list = document.getElementsByTagName(el.tagName);
    for (var i = 0; i < list.length && out.length < MAX_SIMILAR; i++) {
      var c = list[i];
      if (c === el || isOurs(c) || c.contains(el) || el.contains(c)) continue;
      if ((c.getAttribute('class') || '').trim() === cls) out.push(c);
    }
    return out;
  }

  function themeItem() { for (var i = 0; i < state.items.length; i++) if (state.items[i].kind === 'theme') return state.items[i]; return null; }
  function removeThemeStyle() { var s = document.getElementById(THEME_STYLE_ID); if (s) s.remove(); }
  function applyTheme(item) {
    var css = themeCss((item.theme && item.theme.tokens) || {});
    var style = document.getElementById(THEME_STYLE_ID);
    if (!css) { if (style) style.remove(); return; }
    if (!style) {
      style = document.createElement('style');
      style.id = THEME_STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = css;
  }

  /** Find (or re-find) an item's element; flagged `missing` when it isn't on this page. */
  function anchorItem(item) {
    var el = anchor(item);
    var p = proj[item.id] = { el: el, els: [] };
    if (!el) { item.missing = true; return; }
    item.missing = undefined;
    p.els = [el].concat(item.similar ? similarOf(el) : []);
  }
  function project(item) {
    if (item.kind === 'theme') applyTheme(item); else anchorItem(item);
    compose();
  }
  /** Re-find items whose elements went away (route change / re-render) and re-apply every preview. */
  function reprojectStale() {
    var changed = false;
    state.items.forEach(function (item) {
      if (item.kind === 'theme') return;
      var p = proj[item.id];
      if (p && p.el && p.el.isConnected) {
        // "All like this" follows lists that re-rendered.
        if (item.similar && p.els.some(function (n) { return !n.isConnected; })) p.els = [p.el].concat(similarOf(p.el));
        return;
      }
      var wasMissing = !!item.missing;
      anchorItem(item);
      if (wasMissing !== !!item.missing) changed = true;
    });
    compose();
    if (changed) bump();
  }

  // ---- item edits ---------------------------------------------------------------
  function findTweak(item, kind) { for (var i = 0; i < item.tweaks.length; i++) if (item.tweaks[i].kind === kind) return i; return -1; }
  function describeChange(t) {
    if (t.kind === 'text' && t.text) return '“' + clip(t.text.from, 40) + '” → “' + clip(t.text.to, 40) + '”';
    if (t.tailwind && t.tailwind.to) return (t.tailwind.from || (t.css && t.css[0] && t.css[0].from) || 'default') + ' → ' + t.tailwind.to;
    return (t.css || []).map(function (c) { return c.property + (c.from ? ' ' + clip(c.from, 30) + ' →' : '') + ' ' + clip(c.to, 40); }).join(', ');
  }
  /** Add (or replace, keeping the original "from") one tweak of `tweak.kind`. */
  function setTweak(item, tweak, label) {
    pushUndo(item);
    var i = findTweak(item, tweak.kind);
    if (i >= 0) {
      var prev = item.tweaks[i];
      if (prev.tailwind && tweak.tailwind) tweak.tailwind.from = prev.tailwind.from;
      if (prev.text && tweak.text) tweak.text.from = prev.text.from;
      (tweak.css || []).forEach(function (c) {
        (prev.css || []).forEach(function (o) { if (o.property === c.property) c.from = o.from; });
      });
    }
    if (!tweak.summary) tweak.summary = label + ': ' + describeChange(tweak);
    if (i >= 0) item.tweaks[i] = tweak; else item.tweaks.push(tweak);
  }
  function dropTweak(item, kind) {
    var i = findTweak(item, kind);
    if (i < 0) return;
    pushUndo(item);
    item.tweaks.splice(i, 1);
  }
  function dropItem(item) {
    if (item.kind === 'theme') removeThemeStyle();
    delete proj[item.id];
    var i = itemIndex(item.id);
    if (i >= 0) state.items.splice(i, 1);
    if (state.selected && state.selected.itemId === item.id) state.selected.itemId = null;
    if (state.lastItemId === item.id) state.lastItemId = null;
    compose();
  }
  /** Re-preview an edited item, drop it if it's now empty, and notify the host. */
  function commit(item) {
    endPreview(true);
    project(item);
    state.lastItemId = item.id;
    if (!hasContent(item)) dropItem(item);
    bump();
    renderCard();
    renderPanel();
  }
  function undo(item) {
    if (!item || !item._undo || !item._undo.length) return;
    endPreview(true);
    var prev = JSON.parse(item._undo.pop());
    item.instruction = prev.instruction;
    item.tweaks = prev.tweaks || [];
    item.chart = prev.chart;
    item.similar = prev.similar;
    item.theme = prev.theme;
    project(item);
    if (!hasContent(item)) dropItem(item);
    bump();
    renderCard();
    renderPanel();
  }
  function removeItem(id) {
    var item = itemById(id);
    if (!item) return;
    endPreview(true);
    dropItem(item);
    bump();
    renderCard();
    renderPanel();
  }
  function clearItems() {
    endPreview(true);
    removeThemeStyle();
    state.items = [];
    proj = {};
    compose();
    state.lastItemId = null;
    if (state.selected) state.selected.itemId = null;
    bump();
    renderCard();
    renderPanel();
  }
  function seedItems(sessionId, items) {
    endPreview(true);
    removeThemeStyle();
    proj = {};
    state.sessionId = sessionId || null;
    state.items = (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS).map(function (it) {
      var item = cloneVal(it);
      item.tweaks = item.tweaks || [];
      return item;
    });
    state.items.forEach(function (item) { if (item.kind === 'theme') applyTheme(item); else anchorItem(item); });
    compose();
    closeCard();
    bump();
    renderPanel();
  }

  // ---- chrome (Shadow DOM) ------------------------------------------------------
  var host = null, root = null;
  var ui = {}; // hover, tag, sel, similar, pins, card, panel, banner, intro, toast
  function isOurs(node) { return !!(node && host && (node === host || (node.closest && node.closest('#' + HOST_ID)))); }
  function inOurUi(e) {
    if (!host) return false;
    var path = e.composedPath ? e.composedPath() : [];
    return path.indexOf(host) >= 0 || isOurs(e.target);
  }

  var DEFAULT_CHROME = { accent: '#34b4ba', panel: '#12161f', txt: '#eceff5' };
  function mix(a, b, t) {
    var x = parseColor(a) || { r: 0, g: 0, b: 0 }, y = parseColor(b) || { r: 255, g: 255, b: 255 };
    return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
  }
  function hexOf(c, fallback) { var p = parseColor(c); return p ? toHex(p) : fallback; }
  function chromeVars(t) {
    t = t || {};
    var accent = hexOf(t.accent, DEFAULT_CHROME.accent), panel = hexOf(t.panel, DEFAULT_CHROME.panel), txt = hexOf(t.txt, DEFAULT_CHROME.txt);
    var onAccent = luminance(parseColor(accent)) > 0.4 ? '#0b1a1b' : '#ffffff';
    return {
      '--rf-accent': accent,
      '--rf-accent-hi': hexOf(t.accentHi, mix(accent, '#ffffff', 0.2)),
      '--rf-on-accent': onAccent,
      '--rf-panel': panel,
      '--rf-panel2': hexOf(t.panel2, mix(panel, txt, 0.07)),
      '--rf-border': hexOf(t.border, mix(panel, txt, 0.16)),
      '--rf-txt': txt,
      '--rf-dim': hexOf(t.txtDim, mix(txt, panel, 0.42)),
      '--rf-scale': String(typeof t.scale === 'number' && t.scale > 0 ? clamp(t.scale, 0.8, 2) : 1)
    };
  }
  function applyChrome() {
    if (!host) return;
    var vars = chromeVars(state.hostTheme);
    for (var k in vars) host.style.setProperty(k, vars[k]);
  }

  var STYLE = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.layer{position:fixed;inset:0;pointer-events:none;z-index:2147483600;font:13px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--rf-txt);-webkit-font-smoothing:antialiased}',
    '.layer.capturing>*{display:none!important}',
    '.box{position:fixed;display:none;pointer-events:none;border-radius:4px}',
    '.box.hover{outline:1.5px solid var(--rf-accent);background:color-mix(in srgb,var(--rf-accent) 8%,transparent)}',
    '.box.sel{outline:2px solid var(--rf-accent);outline-offset:1px}',
    '.box.sim{outline:1.5px dashed color-mix(in srgb,var(--rf-accent) 75%,transparent)}',
    '.tag{position:fixed;display:none;pointer-events:none;max-width:320px;padding:2px 8px;border-radius:6px;background:var(--rf-accent);color:var(--rf-on-accent);font-size:calc(11.5px*var(--rf-scale));font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 8px rgba(0,0,0,.25)}',
    '.pin{position:fixed;display:flex;align-items:center;justify-content:center;min-width:calc(20px*var(--rf-scale));height:calc(20px*var(--rf-scale));padding:0 5px;border-radius:999px;background:var(--rf-accent);color:var(--rf-on-accent);font-size:calc(11px*var(--rf-scale));font-weight:700;pointer-events:auto;cursor:pointer;box-shadow:0 0 0 2px var(--rf-panel),0 2px 8px rgba(0,0,0,.3);transform:translate(-40%,-40%)}',
    '.pin.missing{display:none}',
    '.float{position:fixed;pointer-events:auto}',
    '.surface{zoom:var(--rf-scale);background:var(--rf-panel);color:var(--rf-txt);border:1px solid var(--rf-border);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.35),0 2px 6px rgba(0,0,0,.2)}',
    '.card{width:312px;max-height:calc(100vh - 24px);overflow:auto}',
    '.panel{width:300px;max-height:calc(100vh - 24px);overflow:auto}',
    '.head{display:flex;align-items:center;gap:6px;padding:10px 10px 8px 12px;border-bottom:1px solid var(--rf-border)}',
    '.head .title{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.icon-btn.flip svg{transform:scaleX(-1)}',
    '.num{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--rf-accent);color:var(--rf-on-accent);font-size:11px;font-weight:700}',
    '.sec{padding:10px 12px;border-bottom:1px solid var(--rf-border)}',
    '.sec:last-child{border-bottom:0}',
    '.label{display:block;margin:0 0 6px;color:var(--rf-dim);font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase}',
    'textarea,input[type=text],select{width:100%;font:inherit;color:var(--rf-txt);background:var(--rf-panel2);border:1px solid var(--rf-border);border-radius:8px;padding:7px 9px;outline:none}',
    'textarea{resize:vertical;min-height:54px}',
    'textarea:focus,input[type=text]:focus,select:focus{border-color:var(--rf-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--rf-accent) 22%,transparent)}',
    'button{font:inherit;color:inherit;cursor:pointer}',
    'button:disabled{opacity:.45;cursor:default}',
    '.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--rf-dim)}',
    '.icon-btn:hover:not(:disabled),.icon-btn.on{background:var(--rf-panel2);color:var(--rf-txt)}',
    '.icon-btn svg,.btn svg,.tool svg{width:16px;height:16px}',
    '.btn{display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border:1px solid var(--rf-border);border-radius:8px;background:var(--rf-panel2);font-weight:600;font-size:12.5px}',
    '.btn:hover:not(:disabled){border-color:color-mix(in srgb,var(--rf-accent) 60%,var(--rf-border))}',
    '.btn.primary{background:var(--rf-accent);border-color:var(--rf-accent);color:var(--rf-on-accent)}',
    '.btn.primary:hover:not(:disabled){background:var(--rf-accent-hi)}',
    '.btn.ghost{background:transparent}',
    '.row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
    '.row.end{justify-content:flex-end}',
    '.spacer{flex:1}',
    '.chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}',
    '.chip{padding:3px 9px;border:1px solid var(--rf-border);border-radius:999px;background:transparent;color:var(--rf-dim);font-size:12px}',
    '.chip:hover{color:var(--rf-txt);border-color:var(--rf-accent)}',
    '.tools{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:3px}',
    '.tool{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0;padding:7px 1px 5px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--rf-dim);font-size:10px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tool:hover:not(:disabled){background:var(--rf-panel2);color:var(--rf-txt)}',
    '.tool.on{background:color-mix(in srgb,var(--rf-accent) 16%,transparent);border-color:color-mix(in srgb,var(--rf-accent) 45%,transparent);color:var(--rf-txt)}',
    '.tool.done{color:var(--rf-accent)}',
    '.sub{margin-top:9px;padding:9px;border-radius:9px;background:var(--rf-panel2)}',
    '.seg{display:flex;padding:2px;border:1px solid var(--rf-border);border-radius:8px;background:var(--rf-panel)}',
    '.seg button{flex:1;padding:4px 6px;border:0;border-radius:6px;background:transparent;color:var(--rf-dim);font-size:12px;font-weight:600;white-space:nowrap}',
    '.seg button.on{background:var(--rf-accent);color:var(--rf-on-accent)}',
    '.seg button:not(.on):hover,.seg button:not(.on):focus-visible{background:var(--rf-panel2);color:var(--rf-txt)}',
    '.stepper{display:flex;align-items:center;gap:6px}',
    '.stepper .val{flex:1;text-align:center;font-variant-numeric:tabular-nums;font-size:12.5px}',
    '.swatches{display:grid;grid-template-columns:repeat(9,1fr);gap:4px}',
    '.swatch{position:relative;height:20px;border:1px solid rgba(127,127,127,.35);border-radius:5px;padding:0;transition:transform .08s ease}',
    '.swatch:hover,.swatch:focus-visible{transform:scale(1.15);z-index:1;box-shadow:0 2px 8px rgba(0,0,0,.35)}',
    '.swatch.on{outline:2px solid var(--rf-accent);outline-offset:1px}',
    '.hues{display:grid;grid-template-columns:repeat(9,1fr);gap:4px;margin-top:6px}',
    '.pal-name{margin:8px 0 4px;color:var(--rf-dim);font-size:11px}',
    '.muted{color:var(--rf-dim);font-size:12px}',
    '.note{margin-top:6px;color:var(--rf-dim);font-size:11.5px}',
    '.queued{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}',
    '.queued li{display:flex;gap:6px;align-items:flex-start;font-size:12px;color:var(--rf-dim)}',
    '.queued li b{color:var(--rf-txt);font-weight:600}',
    '.options{display:flex;flex-direction:column;gap:6px}',
    '.option{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;padding:8px 10px;border:1px solid var(--rf-border);border-radius:9px;background:var(--rf-panel2);text-align:left}',
    '.option:hover,.option:focus-visible{border-color:color-mix(in srgb,var(--rf-accent) 60%,var(--rf-border))}',
    '.option.on{border-color:var(--rf-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--rf-accent) 20%,transparent)}',
    '.option b{font-size:12.5px}',
    '.option span{color:var(--rf-dim);font-size:11.5px}',
    '.busy{display:flex;align-items:center;gap:8px;color:var(--rf-dim);font-size:12px}',
    '.elapsed{color:var(--rf-dim);font-size:11.5px;font-variant-numeric:tabular-nums}',
    '.spin{width:14px;height:14px;border:2px solid var(--rf-border);border-top-color:var(--rf-accent);border-radius:50%;animation:rfspin .8s linear infinite}',
    '@keyframes rfspin{to{transform:rotate(360deg)}}',
    '.banner{position:fixed;top:12px;left:50%;transform:translateX(-50%);pointer-events:auto;display:flex;align-items:center;gap:8px;padding:8px 14px}',
    '.intro{position:fixed;top:12px;left:50%;transform:translateX(-50%);pointer-events:auto;max-width:440px;padding:12px 14px}',
    '.intro p{margin:0 0 8px}',
    '.toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);padding:8px 14px;pointer-events:none;font-weight:600;font-size:12.5px}',
    '.sugg{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-bottom:1px solid var(--rf-border)}',
    '.sugg:last-child{border-bottom:0}',
    '.sugg .t{font-weight:600}',
    '.sugg .w{color:var(--rf-dim);font-size:12px}',
    '.check{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--rf-dim);cursor:pointer}',
    '.check input{accent-color:var(--rf-accent)}',
    '@media (prefers-reduced-motion: reduce){.spin{animation:none}}'
  ].join('\n');

  function buildChrome() {
    host = document.getElementById(HOST_ID);
    if (host) host.remove();
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-rayfin-design', '');
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    root.appendChild(h('style', { text: STYLE }));
    var layer = h('div', { class: 'layer' });
    root.appendChild(layer);
    ui.layer = layer;
    ui.hover = h('div', { class: 'box hover' });
    ui.tag = h('div', { class: 'tag' });
    ui.sel = h('div', { class: 'box sel' });
    ui.similar = h('div');
    ui.pins = h('div');
    ui.card = h('div', { class: 'float' });
    ui.panel = h('div', { class: 'float' });
    ui.banner = h('div');
    ui.intro = h('div');
    ui.toast = h('div');
    [ui.hover, ui.similar, ui.sel, ui.tag, ui.pins, ui.card, ui.panel, ui.banner, ui.intro, ui.toast].forEach(function (n) { layer.appendChild(n); });
    // Keep keyboard and pointer events from our UI out of the app's own handlers.
    ['keydown', 'keyup', 'keypress', 'input', 'click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'focusin', 'focusout', 'wheel'].forEach(function (type) {
      host.addEventListener(type, function (e) { e.stopPropagation(); });
    });
    // Clicking a choice re-renders the card, which can shift a different choice
    // under a still pointer; hover previews wait until the pointer really moves.
    root.addEventListener('pointerdown', function (e) { hoverHold = { x: e.clientX, y: e.clientY }; }, true);
    root.addEventListener('pointermove', function (e) { if (hoverHold && !nearHold(e)) hoverHold = null; }, true);
    applyChrome();
  }
  function destroyChrome() {
    if (host) host.remove();
    host = root = null;
    ui = {};
  }

  var toastTimer = 0;
  function toast(message) {
    if (!ui.toast) return;
    clearTimeout(toastTimer);
    ui.toast.className = message ? 'toast surface' : '';
    ui.toast.textContent = message || '';
    if (message) toastTimer = setTimeout(function () { toast(''); }, 2600);
  }

  // ---- the change card ------------------------------------------------------------
  var SUGGEST = {
    button: ['Make it the primary action', 'Make it more subtle', 'Add an icon', 'Change the label'],
    link: ['Turn it into a button', 'Make it more visible', 'Change the wording'],
    heading: ['Make it bigger', 'Rewrite this title', 'Add a subtitle', 'Make it bolder'],
    text: ['Rewrite this copy', 'Make it easier to read', 'Make it stand out', 'Make it smaller'],
    card: ['Give it more breathing room', 'Make it stand out', 'Soften the shadow', 'Add an icon'],
    chart: ['Switch to a bar chart', 'Sort from high to low', 'Add a target line', 'Show data labels'],
    image: ['Round the corners', 'Make it larger', 'Add a caption'],
    icon: ['Use a different icon', 'Make it larger', 'Match the text color'],
    field: ['Add a clear label', 'Add validation', 'Make it wider'],
    list: ['Add dividers', 'Tighten the spacing', 'Show as a grid'],
    item: ['Highlight the selected item', 'Add an icon'],
    table: ['Add zebra striping', 'Make the header sticky', 'Tighten the rows'],
    nav: ['Make it sticky', 'Highlight the current page', 'Add a search box'],
    header: ['Make it sticky', 'Add a search box', 'Simplify it'],
    footer: ['Add useful links', 'Make it more compact'],
    section: ['Add more spacing', 'Center the content', 'Split into two columns'],
    container: ['Add more spacing', 'Align the items', 'Show as a grid'],
    element: ['Make it stand out', 'Remove this']
  };
  var TEXTUAL = /^(text|heading|button|link|item|field|element)$/;
  var BOXY = /^(button|card|section|container|field|list|item|nav|header|footer|table|image|element)$/;

  function toolsFor(el, role) {
    if (role === 'chart') return ['hide', 'move'];
    var t = [];
    if (role !== 'image' && role !== 'field' && textHost(el)) t.push('text');
    if (role !== 'image') t.push('color');
    if (TEXTUAL.test(role)) t.push('size');
    if (BOXY.test(role) || flowSelf(el)) t.push('spacing');
    if (BOXY.test(role)) t.push('corners');
    if (/^(button|card|section|container|image)$/.test(role)) t.push('shadow');
    if (TEXTUAL.test(role) || flowSelf(el)) t.push('align');
    t.push('hide', 'move');
    return t;
  }
  var TOOL_LABELS = { text: 'Text', color: 'Color', size: 'Size', spacing: 'Spacing', corners: 'Corners', shadow: 'Shadow', align: 'Align', hide: 'Hide', move: 'Move' };
  var TOOL_KINDS = { text: ['text'], color: ['color', 'background'], size: ['size', 'weight'], spacing: ['spacing', 'gap'], corners: ['corners'], shadow: ['shadow'], align: ['align'], hide: ['hide'], move: ['order'] };
  function flowSelf(el) { var d = getComputedStyle(el).display; return /flex|grid/.test(d) ? d : ''; }

  function currentItem() { var sel = state.selected; return sel && sel.itemId ? itemById(sel.itemId) : null; }
  function ensureItem() {
    var sel = state.selected;
    if (!sel) return null;
    var item = currentItem();
    if (item) return item;
    if (state.items.length >= MAX_ITEMS) { toast('That’s a lot of changes — send these first.'); return null; }
    item = newElementItem(sel.el);
    if (sel.similarOn && sel.similar.length) item.similar = sel.similar.length;
    sel.itemId = item.id;
    return item;
  }

  function openCard(el, tool) {
    if (!el || !el.isConnected) return;
    closeCard();
    var item = itemForElement(el);
    var sel = state.selected = {
      el: el, itemId: item ? item.id : null, similar: similarOf(el), similarOn: !!(item && item.similar),
      tool: tool || null, options: null, optionsError: '', pending: null, choice: -1, lastRect: null, dom: {}
    };
    var card = h('div', { class: 'card surface', role: 'dialog', 'aria-label': 'Change ' + labelOf(el) });
    var dom = sel.dom = {
      card: card,
      head: h('div', { class: 'head' }),
      ask: h('div', { class: 'sec' }),
      tools: h('div', { class: 'sec' }),
      chart: h('div'),
      options: h('div'),
      queued: h('div'),
      foot: h('div', { class: 'sec' })
    };
    var ta = h('textarea', { rows: '2', placeholder: 'What should change? e.g. “make this the primary action”', 'aria-label': 'What should change' });
    ta.value = (item && item.instruction) || '';
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addInstruction(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeCard(); }
    });
    sel.textarea = ta;
    var chips = h('div', { class: 'chips' });
    (SUGGEST[roleOf(el)] || SUGGEST.element).forEach(function (s) {
      chips.appendChild(h('button', { type: 'button', class: 'chip', text: s, onclick: function () { ta.value = s; ta.focus(); } }));
    });
    sel.addButton = h('button', { type: 'button', class: 'btn primary', text: item && item.instruction ? 'Update' : 'Add', onclick: addInstruction });
    sel.optionsButton = h('button', { type: 'button', class: 'btn ghost', title: 'Show a few designed options for this element', html: svgIcon('sparkle') + '<span>Options</span>', onclick: requestVariations });
    dom.ask.appendChild(ta);
    dom.ask.appendChild(chips);
    dom.ask.appendChild(h('div', { class: 'row end', style: 'margin-top:8px' }, [sel.optionsButton, sel.addButton]));
    [dom.head, dom.ask, dom.tools, dom.chart, dom.options, dom.queued, dom.foot].forEach(function (n) { card.appendChild(n); });
    ui.card.textContent = '';
    ui.card.appendChild(card);
    ui.card.style.display = 'block';
    renderCard();
    positionCard();
    setTimeout(function () { if (state.selected === sel && !sel.tool) try { ta.focus({ preventScroll: true }); } catch (e) {} }, 0);
  }
  function closeCard() {
    endPreview();
    state.selected = null;
    if (ui.card) { ui.card.textContent = ''; ui.card.style.display = 'none'; }
  }
  function selectParent() {
    var sel = state.selected;
    if (!sel) return;
    var parent = sel.el.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) { toast('This is the outermost element.'); return; }
    openCard(chartRoot(parent) || parent);
  }
  function addInstruction() {
    var sel = state.selected;
    if (!sel) return;
    var text = sel.textarea.value.trim();
    var item = currentItem();
    if (!text && !item) { sel.textarea.focus(); return; }
    item = item || ensureItem();
    if (!item) return;
    pushUndo(item);
    item.instruction = text || undefined;
    commit(item);
    toast(text ? 'Added to your changes' : 'Instruction removed');
  }

  function renderCard() {
    var sel = state.selected;
    if (!sel || !ui.card || !sel.dom.card) return;
    // The hovered control is about to be replaced, so its mouseleave never fires.
    endPreview();
    hovered = null;
    var el = sel.el, item = currentItem(), role = roleOf(el), dom = sel.dom;
    renderCardHead(sel, item);
    if (sel.optionsButton) sel.optionsButton.disabled = !!sel.pending;

    // Tools row + the active tool's controls.
    dom.tools.textContent = '';
    var tools = toolsFor(el, role);
    var grid = h('div', { class: 'tools' });
    tools.forEach(function (name) {
      var done = item && TOOL_KINDS[name].some(function (k) { return findTweak(item, k) >= 0; });
      grid.appendChild(h('button', {
        type: 'button', class: 'tool' + (sel.tool === name ? ' on' : '') + (done ? ' done' : ''), title: TOOL_LABELS[name], 'aria-pressed': sel.tool === name ? 'true' : 'false',
        html: svgIcon(name) + '<span>' + TOOL_LABELS[name] + '</span>',
        onclick: function () { sel.tool = sel.tool === name ? null : name; sel.focusTool = true; renderCard(); positionCard(); }
      }));
    });
    dom.tools.appendChild(grid);
    if (sel.tool && tools.indexOf(sel.tool) >= 0) {
      var sub = h('div', { class: 'sub' });
      renderTool(sel.tool, sub, el, role, item);
      dom.tools.appendChild(sub);
    }
    sel.focusTool = false;

    // Chart controls.
    dom.chart.textContent = '';
    dom.chart.className = role === 'chart' ? 'sec' : '';
    if (role === 'chart') renderChartControls(dom.chart, el, item);

    // AI options.
    dom.options.textContent = '';
    dom.options.className = sel.pending || sel.options || sel.optionsError ? 'sec' : '';
    if (sel.pending) renderPending(dom.options, sel);
    else if (sel.optionsError) {
      dom.options.appendChild(h('div', { class: 'muted', text: sel.optionsError }));
      dom.options.appendChild(h('div', { class: 'row end', style: 'margin-top:8px' }, [
        h('button', { type: 'button', class: 'btn ghost', text: 'Dismiss', onclick: function () { sel.optionsError = ''; renderCard(); } }),
        h('button', { type: 'button', class: 'btn', html: svgIcon('sparkle') + '<span>Try again</span>', onclick: requestVariations })
      ]));
    }
    else if (sel.options) renderOptions(dom.options);

    renderCardSummary(sel, item);
  }
  function renderCardHead(sel, item) {
    var dom = sel.dom, n = item ? itemIndex(item.id) + 1 : 0;
    dom.head.textContent = '';
    if (n) dom.head.appendChild(h('span', { class: 'num', text: String(n), title: 'Change ' + n }));
    var label = item && item.target ? item.target.label : labelOf(sel.el);
    dom.head.appendChild(h('span', { class: 'title', text: label, title: label }));
    dom.head.appendChild(iconButton('parent', 'Select the parent element', selectParent));
    dom.head.appendChild(iconButton('close', 'Close (Esc)', closeCard));
    if (sel.addButton) sel.addButton.textContent = item && item.instruction ? 'Update' : 'Add';
  }
  /** "In this change" list and the footer (scope, undo, remove). */
  function renderCardSummary(sel, item) {
    var dom = sel.dom;
    dom.queued.textContent = '';
    dom.queued.className = item ? 'sec' : '';
    if (item) {
      dom.queued.appendChild(h('span', { class: 'label', text: 'In this change' }));
      var list = h('ul', { class: 'queued' });
      if (item.instruction) list.appendChild(h('li', null, [h('b', { text: '“' + clip(item.instruction, 120) + '”' })]));
      item.tweaks.forEach(function (t) {
        list.appendChild(h('li', null, [
          h('span', { class: 'spacer', text: t.summary }),
          iconButton('close', 'Undo this tweak', function () { dropTweak(item, t.kind); commit(item); })
        ]));
      });
      if (item.chart) item.chart.summary.forEach(function (line) { list.appendChild(h('li', { text: 'Chart ' + line })); });
      dom.queued.appendChild(list);
    }

    dom.foot.textContent = '';
    var foot = h('div', { class: 'row' });
    if (sel.similar.length) {
      var box = h('input', { type: 'checkbox' });
      box.checked = !!(item ? item.similar : sel.similarOn);
      box.addEventListener('change', function () {
        sel.similarOn = box.checked;
        var it = currentItem();
        if (it) { pushUndo(it); it.similar = box.checked ? sel.similar.length : undefined; commit(it); }
      });
      foot.appendChild(h('label', { class: 'check' }, [box, 'Also ' + sel.similar.length + ' more like this']));
    }
    foot.appendChild(h('span', { class: 'spacer' }));
    var undoBtn = iconButton('undo', 'Undo (Ctrl+Z)', function () { undo(currentItem()); });
    undoBtn.disabled = !(item && item._undo && item._undo.length);
    foot.appendChild(undoBtn);
    var rm = iconButton('trash', 'Remove this change', function () { if (item) removeItem(item.id); });
    rm.disabled = !item;
    foot.appendChild(rm);
    dom.foot.appendChild(foot);
  }

  // ---- tool controls -----------------------------------------------------------------
  /** Segmented choice; with `onPreview`, hovering a choice previews it on the page. */
  function seg(options, current, onPick, onPreview) {
    var wrap = h('div', { class: 'seg', role: 'group' });
    options.forEach(function (o) {
      // A choice's tweak reads the element's current look, so the hovered preview
      // ends first (synchronously, so nothing flickers).
      var b = h('button', { type: 'button', class: o[0] === current ? 'on' : '', 'aria-pressed': o[0] === current ? 'true' : 'false', text: o[1], title: o[2] || o[1], onclick: function () { endPreviews(); onPick(o[0]); } });
      if (onPreview && o[0] !== current) hoverPreview(b, function () { onPreview(o[0]); });
      wrap.appendChild(b);
    });
    return wrap;
  }
  function stepper(label, value, onStep, title) {
    return h('div', { class: 'stepper' }, [
      h('span', { class: 'muted', text: label, style: 'min-width:54px' }),
      h('button', { type: 'button', class: 'btn', text: '−', title: 'Less ' + title, 'aria-label': 'Less ' + title, onclick: function () { onStep(-1); } }),
      h('span', { class: 'val', text: value }),
      h('button', { type: 'button', class: 'btn', text: '+', title: 'More ' + title, 'aria-label': 'More ' + title, onclick: function () { onStep(1); } })
    ]);
  }
  function tweakOf(item, kind) { var i = item ? findTweak(item, kind) : -1; return i >= 0 ? item.tweaks[i] : null; }
  /** Record one tweak on the selected element's item and preview it. */
  function record(tweak, label) {
    endPreview();
    var item = ensureItem();
    if (!item) return;
    setTweak(item, tweak, label);
    commit(item);
  }

  function cornersTweak(el, tok, v) {
    var spec = RADII.filter(function (x) { return x[0] === v; })[0];
    var css = v === 'none' ? '0px' : v === 'full' ? '9999px' : 'var(--radius-' + v + ', ' + spec[1] + ')';
    return { kind: 'corners', tailwind: { from: tok || undefined, to: 'rounded-' + v }, css: [{ property: 'border-radius', from: getComputedStyle(el).borderTopLeftRadius, to: css }] };
  }
  function shadowTweak(el, tok, v) {
    var spec = SHADOWS.filter(function (x) { return x[0] === v; })[0];
    return { kind: 'shadow', tailwind: { from: tok || undefined, to: 'shadow-' + v }, css: [{ property: 'box-shadow', from: getComputedStyle(el).boxShadow, to: spec[1] }] };
  }

  function renderTool(name, box, el, role, item) {
    if (name === 'text') return renderTextTool(box, el, item);
    if (name === 'color') return renderColorTool(box, el, role, item);
    if (name === 'size') return renderSizeTool(box, el, item);
    if (name === 'spacing') return renderSpacingTool(box, el, item);
    if (name === 'corners') {
      var r = tweakOf(item, 'corners'), tok = baseToken(el, /^rounded(-(none|xs|sm|md|lg|xl|2xl|3xl|4xl|full))?$/);
      var cur = r ? r.tailwind.to.replace(/^rounded-?/, '') : tok ? (tok.replace(/^rounded-?/, '') || 'sm') : '';
      box.appendChild(seg(RADII.map(function (x) { return [x[0], x[2], 'rounded-' + x[0]]; }), cur, function (v) {
        record(cornersTweak(el, tok, v), 'Corners');
      }, function (v) { previewTweak(cornersTweak(el, tok, v)); }));
      return;
    }
    if (name === 'shadow') {
      var s = tweakOf(item, 'shadow'), stok = baseToken(el, /^shadow(-(2xs|xs|sm|md|lg|xl|2xl|none))?$/);
      var scur = s ? s.tailwind.to.replace(/^shadow-?/, '') : stok ? (stok.replace(/^shadow-?/, '') || 'sm') : 'none';
      box.appendChild(seg(SHADOWS.map(function (x) { return [x[0], x[2], 'shadow-' + x[0]]; }), scur, function (v) {
        record(shadowTweak(el, stok, v), 'Shadow');
      }, function (v) { previewTweak(shadowTweak(el, stok, v)); }));
      return;
    }
    if (name === 'align') {
      var flex = flowSelf(el) && el.children.length > 1;
      var a = tweakOf(item, 'align');
      if (flex) {
        var jtok = baseToken(el, /^justify-(start|center|end|between|around|evenly)$/);
        var jcur = a ? a.tailwind.to.replace('justify-', '') : jtok ? jtok.replace('justify-', '') : 'start';
        var justify = function (v) {
          var css = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between' }[v];
          return { kind: 'align', tailwind: { from: jtok || undefined, to: 'justify-' + v }, css: [{ property: 'justify-content', from: getComputedStyle(el).justifyContent, to: css }] };
        };
        box.appendChild(h('span', { class: 'label', text: 'Distribute items' }));
        box.appendChild(seg([['start', 'Start'], ['center', 'Center'], ['end', 'End'], ['between', 'Spread']], jcur, function (v) { record(justify(v), 'Align'); }, function (v) { previewTweak(justify(v)); }));
      } else {
        var ttok = baseToken(el, /^text-(left|center|right|justify|start|end)$/);
        var tcur = a ? a.tailwind.to.replace('text-', '') : ttok ? ttok.replace('text-', '') : (getComputedStyle(el).textAlign === 'center' ? 'center' : getComputedStyle(el).textAlign === 'right' ? 'right' : 'left');
        var textAlign = function (v) { return { kind: 'align', tailwind: { from: ttok || undefined, to: 'text-' + v }, css: [{ property: 'text-align', from: getComputedStyle(el).textAlign, to: v }] }; };
        box.appendChild(seg([['left', 'Left'], ['center', 'Center'], ['right', 'Right']], tcur, function (v) { record(textAlign(v), 'Align'); }, function (v) { previewTweak(textAlign(v)); }));
      }
      return;
    }
    if (name === 'hide') {
      var hidden = !!tweakOf(item, 'hide');
      box.appendChild(h('div', { class: 'row' }, [
        h('span', { class: 'spacer muted', text: hidden ? 'Hidden in the preview — Copilot will remove it.' : 'Remove this element from the app.' }),
        h('button', { type: 'button', class: 'btn' + (hidden ? '' : ' primary'), text: hidden ? 'Show it again' : 'Remove it', onclick: function () {
          if (hidden) { dropTweak(item, 'hide'); commit(item); return; }
          state.selected.lastRect = el.getBoundingClientRect();
          record({ kind: 'hide', css: [{ property: 'display', from: getComputedStyle(el).display, to: 'none' }], summary: 'Remove this element' }, 'Remove');
        } })
      ]));
      return;
    }
    if (name === 'move') {
      var parent = flowParent(el);
      var o = tweakOf(item, 'order'), steps = o && o.order ? o.order.steps || 0 : 0;
      var move = function (d) {
        var next = steps + d;
        var it = ensureItem();
        if (!it) return;
        if (!next) { dropTweak(it, 'order'); commit(it); return; }
        var siblings = el.parentElement ? Array.prototype.filter.call(el.parentElement.children, function (c) { return !isOurs(c); }) : [];
        var idx = siblings.indexOf(el), neighbor = siblings[clamp(idx + next, 0, siblings.length - 1)];
        var rel = neighbor && neighbor !== el ? labelOf(neighbor) : '';
        record({ kind: 'order', order: { direction: next < 0 ? 'up' : 'down', steps: next, relativeTo: rel || undefined }, summary: 'Move ' + (next < 0 ? 'earlier' : 'later') + ' by ' + Math.abs(next) + (rel ? (next < 0 ? ' (before ' : ' (after ') + rel + ')' : '') }, 'Move');
      };
      box.appendChild(h('div', { class: 'row' }, [
        h('button', { type: 'button', class: 'btn', html: svgIcon('up') + '<span>Earlier</span>', onclick: function () { move(-1); } }),
        h('button', { type: 'button', class: 'btn', html: svgIcon('down') + '<span>Later</span>', onclick: function () { move(1); } }),
        h('span', { class: 'spacer' })
      ]));
      if (!parent) box.appendChild(h('div', { class: 'note', text: 'No live preview here — Copilot will move it for you.' }));
    }
  }

  function renderTextTool(box, el, item) {
    var t = tweakOf(item, 'text'), hostEl = textHost(el);
    var original = t ? t.text.from : (hostEl ? origOwnText(hostEl) : '');
    var input = h('textarea', { rows: '2', 'aria-label': 'Text' });
    input.value = t ? t.text.to : original;
    var started = false;
    input.addEventListener('input', function () {
      var it = ensureItem();
      if (!it) return;
      var value = input.value.replace(/\s+/g, ' ').trim();
      if (!started) { pushUndo(it); started = true; }
      var i = findTweak(it, 'text');
      if (!value || value === original) { if (i >= 0) it.tweaks.splice(i, 1); }
      else {
        var tw = { kind: 'text', text: { from: original, to: value } };
        tw.summary = 'Text: ' + describeChange(tw);
        if (i >= 0) it.tweaks[i] = tw; else it.tweaks.push(tw);
      }
      project(it);
      state.lastItemId = it.id;
      if (!hasContent(it)) dropItem(it);
      bump();
      renderCardHead(state.selected, currentItem());
      renderCardSummary(state.selected, currentItem());
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); input.blur(); }
    });
    box.appendChild(input);
    box.appendChild(h('div', { class: 'note', text: 'Edits the visible text. If it comes from your data, Copilot will change it at the source.' }));
    if (state.selected.focusTool) setTimeout(function () { try { input.focus({ preventScroll: true }); input.select(); } catch (e) {} }, 0);
  }

  function renderColorTool(box, el, role, item) {
    var sel = state.selected;
    var which = sel.colorTarget || (/^(button|card|section|container|header|footer|nav)$/.test(role) ? 'fill' : 'text');
    box.appendChild(seg([['text', 'Text color'], ['fill', 'Background']], which, function (v) { sel.colorTarget = v; renderCard(); }));
    var prefix = which === 'fill' ? 'bg' : 'text';
    var kind = which === 'fill' ? 'background' : 'color';
    var current = tweakOf(item, kind);
    var currentTok = current && current.tailwind ? current.tailwind.to : colorToken(el, prefix);
    var detected = state.detected || (state.detected = detectTheme());
    var palettes = detected.accents.slice(0, 2).concat(detected.neutral ? [detected.neutral] : ['slate']);
    if (!palettes.length) palettes = ['indigo', 'slate'];
    var colorTweak = function (palette, shade, hex) {
      var fromTok = colorToken(el, prefix);
      var plain = palette === 'white' || palette === 'black' || palette === 'transparent';
      var to = hex ? prefix + '-[' + hex + ']' : plain ? prefix + '-' + palette : prefix + '-' + palette + '-' + shade;
      var value = hex || (palette === 'transparent' ? 'transparent' : paletteVar(palette, shade));
      var cs = getComputedStyle(el);
      return { kind: kind, tailwind: { from: fromTok || undefined, to: to }, css: [{ property: which === 'fill' ? 'background-color' : 'color', from: which === 'fill' ? cs.backgroundColor : cs.color, to: value }] };
    };
    var pick = function (palette, shade, hex) {
      // The tweak records the element's current color, so the hovered preview ends first.
      endPreview();
      record(colorTweak(palette, shade, hex), which === 'fill' ? 'Background' : 'Text color');
    };
    // Every color choice previews on hover and applies on click.
    var choice = function (node, palette, shade) {
      previewable(node, function () { return colorTweak(palette, shade); });
      return node;
    };
    palettes.forEach(function (p) {
      box.appendChild(h('div', { class: 'pal-name', text: p.charAt(0).toUpperCase() + p.slice(1) }));
      var row = h('div', { class: 'swatches' });
      SWATCH_SHADES.forEach(function (shade) {
        var tok = prefix + '-' + p + '-' + shade;
        row.appendChild(choice(h('button', { type: 'button', class: 'swatch' + (currentTok === tok ? ' on' : ''), title: tok, 'aria-label': tok, style: 'background:' + paletteVar(p, shade), onclick: function () { pick(p, shade); } }), p, shade));
      });
      box.appendChild(row);
    });
    var extras = h('div', { class: 'row', style: 'margin-top:8px' });
    ['white', 'black'].concat(which === 'fill' ? ['transparent'] : []).forEach(function (p) {
      var tok = prefix + '-' + p;
      extras.appendChild(choice(h('button', { type: 'button', class: 'chip' + (currentTok === tok ? ' on' : ''), text: p.charAt(0).toUpperCase() + p.slice(1), title: tok, onclick: function () { pick(p); } }), p));
    });
    var custom = h('input', { type: 'color', title: 'Custom color', 'aria-label': 'Custom color', style: 'width:32px;height:24px;border:0;padding:0;background:none' });
    var cp = parseColor(getComputedStyle(el)[which === 'fill' ? 'backgroundColor' : 'color']);
    custom.value = cp ? toHex(cp) : '#000000';
    custom.addEventListener('input', function () { previewTweak(colorTweak(null, null, custom.value)); });
    custom.addEventListener('change', function () { pick(null, null, custom.value); });
    custom.addEventListener('blur', endPreview);
    extras.appendChild(h('span', { class: 'spacer' }));
    extras.appendChild(custom);
    box.appendChild(extras);
    box.appendChild(h('div', { class: 'pal-name', text: 'Other colors' }));
    var hues = h('div', { class: 'hues' });
    Object.keys(HUES).filter(function (n) { return NEUTRALS.indexOf(n) < 0 && palettes.indexOf(n) < 0; }).slice(0, 18).forEach(function (hue) {
      hues.appendChild(choice(h('button', { type: 'button', class: 'swatch', title: prefix + '-' + hue + '-600', 'aria-label': hue, style: 'background:' + paletteVar(hue, '600'), onclick: function () { pick(hue, '600'); } }), hue, '600'));
    });
    box.appendChild(hues);
  }

  function sizeIndexNow(el, item) {
    var t = tweakOf(item, 'size');
    if (t && t.tailwind) { var name = t.tailwind.to.slice(5); for (var i = 0; i < TEXT_SCALE.length; i++) if (TEXT_SCALE[i][0] === name) return i; }
    return textSizeIndex(el).index;
  }
  function renderSizeTool(box, el, item) {
    var index = sizeIndexNow(el, item), step = TEXT_SCALE[index];
    box.appendChild(stepper('Size', step[0] + ' · ' + Math.round(step[1] * 16) + 'px', function (d) {
      var next = clamp(sizeIndexNow(el, currentItem()) + d, 0, TEXT_SCALE.length - 1);
      var s = TEXT_SCALE[next], cs = getComputedStyle(el);
      var fromTok = baseToken(el, /^text-(xs|sm|base|lg|xl|[2-9]xl)$/);
      record({ kind: 'size', tailwind: { from: fromTok || undefined, to: 'text-' + s[0] }, css: [
        { property: 'font-size', from: cs.fontSize, to: 'var(--text-' + s[0] + ', ' + s[1] + 'rem)' },
        { property: 'line-height', from: cs.lineHeight, to: s[2] ? 'var(--text-' + s[0] + '--line-height, ' + s[2] + 'rem)' : '1' }
      ] }, 'Size');
    }, 'size'));
    if (hasVariantOf(el, /^text-(xs|sm|base|lg|xl|[2-9]xl)$/)) box.appendChild(h('div', { class: 'note', text: 'This element also changes size at other screen widths; Copilot will keep those consistent.' }));
    var w = tweakOf(item, 'weight'), wtok = baseToken(el, /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/);
    var wcur = w ? w.tailwind.to.slice(5) : wtok ? wtok.slice(5) : (function () {
      var fw = parseInt(getComputedStyle(el).fontWeight, 10) || 400, best = WEIGHTS[1];
      WEIGHTS.forEach(function (x) { if (Math.abs(x[1] - fw) < Math.abs(best[1] - fw)) best = x; });
      return best[0];
    })();
    var weightTweak = function (v) {
      var spec = WEIGHTS.filter(function (x) { return x[0] === v; })[0];
      return { kind: 'weight', tailwind: { from: wtok || undefined, to: 'font-' + v }, css: [{ property: 'font-weight', from: getComputedStyle(el).fontWeight, to: 'var(--font-weight-' + v + ', ' + spec[1] + ')' }] };
    };
    box.appendChild(h('div', { style: 'margin-top:8px' }, seg(WEIGHTS.slice(1, 5).map(function (x) { return [x[0], x[2], 'font-' + x[0]]; }), wcur, function (v) {
      record(weightTweak(v), 'Weight');
    }, function (v) { previewTweak(weightTweak(v)); })));
  }

  /** Padding (and flex/grid gap) as positions on the Tailwind spacing scale. */
  function paddingModel(el, item) {
    var t = tweakOf(item, 'spacing');
    var src = t && t.tailwind ? t.tailwind.to : null;
    var tokens = src ? src.split(/\s+/) : tokensOf(el).filter(function (x) { return /^p[xytrbl]?-(\d+(\.\d+)?|px)$/.test(x); });
    var x = null, y = null;
    tokens.forEach(function (tok) {
      var m = tok.match(/^p([xytrbl])?-(\d+(\.\d+)?|px)$/);
      if (!m) return;
      var i = spaceIndex(m[2]);
      if (!m[1]) { x = y = i; }
      else if (m[1] === 'x' || m[1] === 'l' || m[1] === 'r') x = i;
      else y = i;
    });
    var cs = getComputedStyle(el);
    if (x === null) x = nearestSpace((parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)) / 2 || 0);
    if (y === null) y = nearestSpace((parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)) / 2 || 0);
    return { x: x, y: y, from: t && t.tailwind ? t.tailwind.from : (tokens.length && !src ? tokens.join(' ') : undefined) };
  }
  function paddingTokens(x, y) {
    return x === y ? spaceToken('p', SPACE_SCALE[x]) : spaceToken('px', SPACE_SCALE[x]) + ' ' + spaceToken('py', SPACE_SCALE[y]);
  }
  function renderSpacingTool(box, el, item) {
    var pm = paddingModel(el, item);
    box.appendChild(stepper('Padding', paddingTokens(pm.x, pm.y), function (d) {
      var m = paddingModel(el, currentItem());
      var x = clamp(m.x + d, 0, SPACE_SCALE.length - 1), y = clamp(m.y + d, 0, SPACE_SCALE.length - 1);
      if (x === m.x && y === m.y) return;
      var cs = getComputedStyle(el);
      record({ kind: 'spacing', tailwind: { from: m.from, to: paddingTokens(x, y) }, css: [{ property: 'padding', from: cs.padding || cs.paddingTop, to: spaceCss(SPACE_SCALE[y]) + ' ' + spaceCss(SPACE_SCALE[x]) }] }, 'Padding');
    }, 'padding'));
    if (flowSelf(el)) {
      var g = tweakOf(item, 'gap'), gtok = baseToken(el, /^gap-(\d+(\.\d+)?|px)$/);
      var gi = g && g.tailwind ? spaceIndex(g.tailwind.to.slice(4)) : gtok ? spaceIndex(gtok.slice(4)) : nearestSpace(parseFloat(getComputedStyle(el).columnGap) || parseFloat(getComputedStyle(el).gap) || 0);
      box.appendChild(h('div', { style: 'margin-top:6px' }, stepper('Gap', 'gap-' + SPACE_SCALE[gi], function (d) {
        var next = clamp(gi + d, 0, SPACE_SCALE.length - 1);
        if (next === gi) return;
        record({ kind: 'gap', tailwind: { from: gtok || undefined, to: spaceToken('gap', SPACE_SCALE[next]) }, css: [{ property: 'gap', from: getComputedStyle(el).gap, to: spaceCss(SPACE_SCALE[next]) }] }, 'Gap');
      }, 'gap')));
    }
  }

  // ---- chart controls -------------------------------------------------------------
  function deepMerge(target, patch) {
    for (var k in patch) {
      var v = patch[k];
      if (k === 'data') continue;
      if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) deepMerge(target[k], v);
      else target[k] = cloneVal(v);
    }
    return target;
  }
  /** Change the selected chart's spec through `mutate(spec)` (data stays live). */
  function changeChart(mutate) {
    var sel = state.selected;
    if (!sel) return;
    var item = ensureItem();
    if (!item) return;
    pushUndo(item);
    var live = readSpec(sel.el) || {};
    var before = item.chart ? item.chart.before : stripData(live);
    var current = item.chart ? cloneVal(item.chart.after) : stripData(live);
    var withData = Object.assign({}, current, { data: live.data });
    mutate(withData);
    var after = stripData(withData);
    var summary = chartSummary(before, after);
    item.chart = summary.length ? { before: before, after: after, summary: summary } : undefined;
    commit(item);
  }
  function selectRow(label, options, current, onChange) {
    var s = h('select', { 'aria-label': label });
    options.forEach(function (o) {
      if (o.group) {
        var og = h('optgroup', { label: o.group });
        o.options.forEach(function (x) { og.appendChild(h('option', { value: x[0], text: x[1], disabled: x[2] ? true : null, selected: x[0] === current ? true : null })); });
        s.appendChild(og);
      } else s.appendChild(h('option', { value: o[0], text: o[1], selected: o[0] === current ? true : null }));
    });
    s.addEventListener('change', function () { onChange(s.value); });
    return h('label', { style: 'display:block;margin-top:6px' }, [h('span', { class: 'label', text: label }), s]);
  }
  function renderChartControls(box, el, item) {
    var spec = item && item.chart ? item.chart.after : stripData(readSpec(el) || {});
    if (!spec || !spec.type) { box.appendChild(h('div', { class: 'muted', text: 'This chart’s spec isn’t readable.' })); return; }
    box.appendChild(h('span', { class: 'label', html: svgIcon('chart').replace('<svg', '<svg style="width:12px;height:12px;vertical-align:-2px;margin-right:4px"') + 'Chart' }));
    var shape = shapeOf(Object.assign({}, spec, { data: (readSpec(el) || {}).data }));
    box.appendChild(selectRow('Type', TYPE_GROUPS.map(function (g) {
      return { group: g[0], options: g[1].map(function (t) { var ok = canConvert(shape, t); return [t, typeLabel(t) + (ok.ok ? '' : ' · ' + ok.reason), !ok.ok]; }) };
    }), spec.type, function (v) {
      changeChart(function (s) {
        var conv = convertSpec(s, v);
        Object.keys(s).forEach(function (k) { delete s[k]; });
        Object.assign(s, conv);
      });
    }));
    box.appendChild(selectRow('Palette', PALETTES.map(function (p) { return [p, p.charAt(0).toUpperCase() + p.slice(1)]; }), typeof spec.palette === 'string' ? spec.palette : 'graphein', function (v) { changeChart(function (s) { s.palette = v; }); }));
    var legend = spec.legend === false ? 'hidden' : (spec.legend && spec.legend.position) || 'auto';
    box.appendChild(selectRow('Legend', [['auto', 'Automatic'], ['top', 'Top'], ['right', 'Right'], ['bottom', 'Bottom'], ['left', 'Left'], ['hidden', 'Hidden']], legend, function (v) {
      changeChart(function (s) { s.legend = v === 'hidden' ? false : v === 'auto' ? true : { show: true, position: v }; });
    }));
    if (/^(bar|line|area|funnel|waterfall|treemap|pie|dumbbell|table)$/.test(spec.type)) {
      box.appendChild(selectRow('Sort', [['none', 'As in the data'], ['descending', 'High to low'], ['ascending', 'Low to high']], spec.sort || 'none', function (v) { changeChart(function (s) { if (v === 'none') delete s.sort; else s.sort = v; }); }));
    }
    if (spec.type === 'bar') {
      box.appendChild(h('div', { style: 'margin-top:8px' }, seg([['vertical', 'Vertical'], ['horizontal', 'Horizontal']], spec.orientation || 'vertical', function (v) { changeChart(function (s) { s.orientation = v; }); })));
    }
    var fmt = (spec.encoding && spec.encoding.y && spec.encoding.y.format) || '';
    if (spec.encoding && spec.encoding.y) {
      box.appendChild(selectRow('Values', FORMATS, fmt, function (v) { changeChart(function (s) { s.encoding = s.encoding || {}; s.encoding.y = s.encoding.y || {}; if (v) s.encoding.y.format = v; else delete s.encoding.y.format; }); }));
    }
    var title = h('input', { type: 'text', 'aria-label': 'Chart title', placeholder: 'Chart title' });
    title.value = chartTitle(spec);
    title.addEventListener('change', function () { changeChart(function (s) { if (s.title && typeof s.title === 'object') s.title.text = title.value; else s.title = title.value; }); });
    box.appendChild(h('label', { style: 'display:block;margin-top:6px' }, [h('span', { class: 'label', text: 'Title' }), title]));
  }

  // ---- AI options (variations) --------------------------------------------------
  var RESTYLE_SNAPSHOT = ['color', 'background-color', 'font-size', 'font-weight', 'line-height', 'text-align', 'padding', 'margin', 'border', 'border-radius', 'box-shadow', 'opacity', 'display', 'width', 'height', 'gap'];
  function restyleContext(el) {
    var cs = getComputedStyle(el), styles = {};
    RESTYLE_SNAPSHOT.forEach(function (p) { var v = cs.getPropertyValue(p); if (v) styles[p] = v.trim(); });
    var isChart = roleOf(el) === 'chart', children = [];
    if (!isChart) {
      var kids = el.querySelectorAll('*');
      for (var i = 0; i < kids.length && children.length < 40; i++) {
        var k = kids[i], tag = k.tagName.toLowerCase(), cls = typeof k.className === 'string' ? k.className.trim() : '';
        if (tag === 'script' || tag === 'style' || isOurs(k)) continue;
        if (!/^(h[1-6]|button|a|p|span|label|input|textarea|img|svg|li|th|td|strong|em|small)$/.test(tag) && !cls) continue;
        children.push({ tag: tag, classes: cls || undefined, text: clip(ownText(k), 48) || undefined });
      }
    }
    var spec = isChart ? stripData(readSpec(el)) : undefined;
    return {
      tag: el.tagName.toLowerCase(),
      text: elementText(el) || undefined,
      classes: (el.getAttribute('class') || '').trim() || undefined,
      component: componentHint(el) || undefined,
      styles: styles,
      isChart: isChart,
      chartType: spec ? spec.type : undefined,
      spec: spec,
      children: children.length ? children : undefined
    };
  }
  function requestVariations() {
    var sel = state.selected;
    if (!sel || sel.pending) return;
    endPreview();
    var id = uid('v');
    sel.pending = id;
    sel.pendingSince = Date.now();
    sel.pendingInfo = '';
    sel.options = null;
    sel.choice = -1;
    sel.optionsError = '';
    state.requests.push({ id: id, kind: 'variations', itemId: sel.itemId || '', context: restyleContext(sel.el), hint: sel.textarea.value.trim() || undefined });
    requestTimes[id] = Date.now();
    bump();
    renderCard();
  }
  function dropRequest(id) { delete requestTimes[id]; state.requests = state.requests.filter(function (r) { return r.id !== id; }); }

  // ---- progress for long-running work ---------------------------------------------
  function elapsedLabel(since) {
    var s = Math.max(0, Math.floor((Date.now() - since) / 1000));
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }
  /** What to tell someone while an Options request runs, given how long it's taken. */
  function pendingNote(sel) {
    var secs = (Date.now() - (sel.pendingSince || Date.now())) / 1000;
    var lines = [];
    if (sel.pendingInfo) lines.push(sel.pendingInfo);
    else if (secs >= 4) lines.push('Waiting for Fabricator to pick this up — keep the preview open.');
    else lines.push('Sending the element’s details…');
    if (secs >= 45) lines.push('Taking longer than usual. You can keep designing — the options will appear here when they’re ready.');
    else if (secs >= 15) lines.push('Still working — options usually take 10–30 seconds.');
    return lines.join(' ');
  }
  function renderPending(box, sel) {
    sel.dom.elapsed = h('span', { class: 'elapsed', text: elapsedLabel(sel.pendingSince || Date.now()) });
    sel.dom.progress = h('div', { class: 'note', role: 'status', 'aria-live': 'polite', text: pendingNote(sel) });
    box.appendChild(h('div', { class: 'busy' }, [h('span', { class: 'spin' }), h('span', { class: 'spacer', text: 'Designing a few options…' }), sel.dom.elapsed]));
    box.appendChild(sel.dom.progress);
    box.appendChild(h('div', { class: 'row end', style: 'margin-top:6px' }, [h('button', { type: 'button', class: 'btn ghost', text: 'Cancel', onclick: cancelVariations })]));
  }
  /** Refresh the live timers (called from the frame loop). */
  function updateProgress() {
    var sel = state.selected;
    if (sel && sel.pending && sel.dom.elapsed) {
      sel.dom.elapsed.textContent = elapsedLabel(sel.pendingSince);
      var note = pendingNote(sel);
      if (sel.dom.progress && sel.dom.progress.textContent !== note) sel.dom.progress.textContent = note;
    }
    if (state.busy && ui.layer) {
      var stamps = root ? root.querySelectorAll('[data-busy-elapsed]') : [];
      for (var i = 0; i < stamps.length; i++) stamps[i].textContent = elapsedLabel(state.busySince || Date.now());
      var hints = root ? root.querySelectorAll('[data-busy-hint]') : [];
      for (var j = 0; j < hints.length; j++) hints[j].textContent = busyHint();
    }
  }
  function busyHint() {
    var secs = (Date.now() - (state.busySince || Date.now())) / 1000;
    if (secs >= 60) return 'Taking longer than usual — the model may be busy. Closing this panel cancels the review.';
    if (secs >= 20) return 'Reviews usually take 20–60 seconds.';
    return '';
  }
  function cancelVariations() {
    var sel = state.selected;
    if (!sel || !sel.pending) return;
    dropRequest(sel.pending);
    sel.pending = null;
    sel.pendingInfo = '';
    renderCard();
    bump();
  }
  function onRequestProgress(requestId, message) {
    var sel = state.selected;
    if (sel && sel.pending === requestId) { sel.pendingInfo = String(message || ''); updateProgress(); }
  }
  // Model-proposed looks (Options, Polish) are re-checked here as well as in the
  // host: the same safe property list (ALLOWED_RESTYLE_PROPS in
  // src-tauri/src/commands/design.rs, kept in sync by a test there), and no
  // external resources or script vectors.
  var SAFE_PROPS = ['color', 'background', 'background-color', 'background-image', 'border', 'border-color', 'border-width', 'border-style', 'border-radius',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'text-decoration', 'opacity', 'box-shadow',
    'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'display', 'gap', 'align-items', 'justify-content', 'flex-direction'];
  var UNSAFE_VALUE = /url\(|expression\(|javascript:|@import|[<>{};]/i;
  function safeStyles(obj) {
    var out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (var k in obj) {
      var key = String(k).trim().toLowerCase(), v = obj[k];
      if (SAFE_PROPS.indexOf(key) < 0 || (typeof v !== 'string' && typeof v !== 'number')) continue;
      v = String(v).trim();
      if (v && v.length <= 200 && !UNSAFE_VALUE.test(v)) out[key] = v;
    }
    return out;
  }
  function safeRules(list) {
    return (Array.isArray(list) ? list : []).map(function (r) {
      var sel = r && typeof r.selector === 'string' ? r.selector.trim() : '';
      if (!sel || sel.length > 100 || /[{}<@";]/.test(sel)) return null;
      var styles = safeStyles(r.styles);
      return Object.keys(styles).length ? { selector: sel, styles: styles } : null;
    }).filter(Boolean).slice(0, 12);
  }
  function safeVariation(o, i) {
    if (!o || typeof o !== 'object') return null;
    var v = {
      name: clip(o.name, 40) || 'Option ' + (i + 1),
      description: clip(o.description, 120) || undefined,
      styles: safeStyles(o.styles),
      rules: safeRules(o.rules),
      graphein: o.graphein && typeof o.graphein === 'object' && !Array.isArray(o.graphein) ? o.graphein : undefined,
      classes: typeof o.classes === 'string' ? clip(o.classes, 200) || undefined : undefined
    };
    return Object.keys(v.styles).length || v.rules.length || v.graphein ? v : null;
  }
  function onVariations(requestId, options) {
    dropRequest(requestId);
    var sel = state.selected;
    if (sel && sel.pending === requestId) {
      sel.pending = null;
      sel.options = (Array.isArray(options) ? options : []).map(safeVariation).filter(Boolean).slice(0, 4);
      if (!sel.options.length) { sel.options = null; sel.optionsError = 'No options came back — try describing what you want.'; }
      renderCard();
      positionCard();
    }
    bump();
  }
  function onRequestFailed(requestId, message) {
    dropRequest(requestId);
    var sel = state.selected;
    if (sel && sel.pending === requestId) { sel.pending = null; sel.optionsError = message || 'Couldn’t design options right now.'; renderCard(); }
    bump();
  }
  // ---- live previews while choosing ------------------------------------------------
  // Hovering a swatch, segment or AI option previews it by projecting a
  // hypothetical version of the element's change; leaving restores the real one
  // and clicking commits it.
  function showPreview(hyp) {
    var sel = state.selected;
    if (!sel) return;
    hoverProj = { hyp: hyp, el: sel.el, els: [sel.el].concat(hyp.similar ? sel.similar : []), replaces: hyp.id || null };
    compose();
  }
  /** Drop the hovered-choice preview (`quiet` when the caller re-composes right after). */
  function endPreview(quiet) {
    if (!hoverProj) return;
    hoverProj = null;
    if (!quiet) compose();
  }
  /** The element's change as it would be with `tweak` (or `chart`) applied. */
  function hypothetical(tweak, chart) {
    var sel = state.selected, item = currentItem();
    var hyp = item ? cloneVal(serializeItem(item)) : { tweaks: [], similar: sel.similarOn && sel.similar.length ? sel.similar.length : undefined };
    if (item) hyp.id = item.id;
    hyp.tweaks = hyp.tweaks || [];
    if (tweak) {
      var i = findTweak(hyp, tweak.kind);
      if (i >= 0) hyp.tweaks[i] = tweak; else hyp.tweaks.push(tweak);
    }
    if (chart) hyp.chart = chart;
    return hyp;
  }
  function previewTweak(tweak) { if (state.selected) showPreview(hypothetical(tweak)); }
  // Where the pointer went down on our UI; hover previews ignore "enters" that
  // happen there without real movement (the card re-rendered under the pointer).
  var hoverHold = null, hovered = null;
  function nearHold(e) { return Math.abs(e.clientX - hoverHold.x) <= 2 && Math.abs(e.clientY - hoverHold.y) <= 2; }
  /** Wire hover / focus previews onto a choice control; leaving restores the page. */
  function hoverPreview(node, show) {
    var enter = function (e) {
      if (hoverHold && e && e.type !== 'focus' && nearHold(e)) return;
      hovered = node;
      show();
    };
    var leave = function () {
      if (hovered === node) hovered = null;
      endPreviews();
    };
    node.addEventListener('mouseenter', enter);
    // Moving within a choice that appeared under a still pointer starts its preview.
    node.addEventListener('mousemove', function (e) { if (hovered !== node) enter(e); });
    node.addEventListener('focus', enter);
    node.addEventListener('mouseleave', leave);
    node.addEventListener('blur', leave);
    return node;
  }
  function previewable(node, makeTweak) {
    return hoverPreview(node, function () { var t = makeTweak(); if (t) previewTweak(t); });
  }
  function endPreviews() { endPreview(); endThemePreview(); }

  // The Theme sheet previews a hovered choice across the whole app the same way.
  var themePreviewing = false;
  function previewTheme(mutate) {
    var d = state.detected || (state.detected = detectTheme());
    var item = themeItem();
    var th = cloneVal((item && item.theme) || { tokens: {}, summary: [] });
    mutate(th, d);
    applyTheme({ theme: { tokens: themeTokens(th, d) } });
    themePreviewing = true;
  }
  function endThemePreview() {
    if (!themePreviewing) return;
    themePreviewing = false;
    var item = themeItem();
    if (item) applyTheme(item); else removeThemeStyle();
  }

  function variationTweak(opt) {
    var css = Object.keys(opt.styles || {}).map(function (prop) { return { property: prop, to: opt.styles[prop] }; });
    return { kind: 'variation', summary: 'Look: ' + opt.name + (opt.description ? ' — ' + opt.description : ''), css: css, rules: opt.rules && opt.rules.length ? opt.rules : undefined, classes: opt.classes };
  }
  function chartWith(patch) {
    var sel = state.selected, item = currentItem();
    var live = readSpec(sel.el) || {};
    var before = item && item.chart ? item.chart.before : stripData(live);
    var after = stripData(deepMerge(Object.assign({}, item && item.chart ? cloneVal(item.chart.after) : stripData(live), { data: live.data }), patch));
    return { before: before, after: after, summary: chartSummary(before, after) };
  }
  function previewOption(i) {
    var sel = state.selected, opt = sel && sel.options && sel.options[i];
    if (!opt) return;
    if (opt.graphein && roleOf(sel.el) === 'chart') showPreview(hypothetical(null, chartWith(opt.graphein)));
    else previewTweak(variationTweak(opt));
  }
  /** Clicking an option applies it right away (it can be swapped or undone). */
  function useOption(i) {
    var sel = state.selected, opt = sel && sel.options && sel.options[i];
    if (!opt) return;
    endPreview();
    var hint = sel.textarea.value.trim();
    if (opt.graphein && roleOf(sel.el) === 'chart') {
      changeChart(function (s) { deepMerge(s, opt.graphein); });
    } else {
      var item = ensureItem();
      if (!item) return;
      setTweak(item, variationTweak(opt), 'Look');
      if (hint && !item.instruction) item.instruction = hint;
      commit(item);
    }
    sel.choice = i;
    renderCard();
    toast('Applied “' + opt.name + '” — it’s in your changes');
  }
  function renderOptions(box) {
    var sel = state.selected;
    box.appendChild(h('span', { class: 'label', text: 'Options — hover to preview, click to apply' }));
    var list = h('div', { class: 'options' });
    sel.options.forEach(function (opt, i) {
      var b = h('button', { type: 'button', class: 'option' + (sel.choice === i ? ' on' : ''), 'aria-pressed': sel.choice === i ? 'true' : 'false' }, [h('b', { text: (sel.choice === i ? '✓ ' : '') + opt.name }), opt.description ? h('span', { text: opt.description }) : null]);
      hoverPreview(b, function () { previewOption(i); });
      b.addEventListener('click', function () { useOption(i); });
      list.appendChild(b);
    });
    box.appendChild(list);
    box.appendChild(h('div', { class: 'row end', style: 'margin-top:8px' }, [
      h('button', { type: 'button', class: 'btn ghost', html: svgIcon('sparkle') + '<span>More options</span>', onclick: requestVariations }),
      h('button', { type: 'button', class: 'btn', text: 'Done', onclick: function () { endPreview(); sel.options = null; sel.choice = -1; renderCard(); } })
    ]));
  }

  // ---- side panels: Theme and Polish --------------------------------------------
  function openPanel(name) {
    // The light/dark preview belongs to the Theme sheet (a Polish review must see the real app).
    if (name !== 'theme' && state.darkPreview != null) setDarkPreview(null);
    state.panel = name || null;
    if (name === 'theme') state.detected = detectTheme();
    if (name !== 'polish') clearSuggestionPreviews();
    renderPanel();
    bump();
  }
  function closePanel() {
    if (state.panel === 'polish') {
      clearSuggestionPreviews();
      // Closing the panel mid-review cancels it (the host drops late results).
      if (state.busy) { state.busy = null; state.busySince = 0; renderBanner(); }
    }
    if (state.darkPreview != null) setDarkPreview(null);
    state.panel = null;
    renderPanel();
    bump();
  }
  function panelShell(title, body) {
    var other = state.panelSide === 'left' ? 'right' : 'left';
    var shell = h('div', { class: 'panel surface', role: 'dialog', 'aria-label': title }, [
      h('div', { class: 'head' }, [
        h('span', { class: 'title', text: title }),
        // The sheet can cover what you're changing; let it move out of the way.
        iconButton('dock', 'Move to the ' + other, function () { state.panelSide = other; renderPanel(); }, other === 'left' ? 'flip' : ''),
        iconButton('close', 'Close', closePanel)
      ])
    ]);
    body.forEach(function (b) { if (b) shell.appendChild(b); });
    return shell;
  }
  function renderPanel() {
    if (!ui.panel) return;
    // The hovered control is about to be replaced, so its mouseleave never fires.
    endThemePreview();
    hovered = null;
    ui.panel.textContent = '';
    if (state.panel === 'theme') ui.panel.appendChild(themePanel());
    else if (state.panel === 'polish') ui.panel.appendChild(polishPanel());
    ui.panel.style.display = state.panel ? 'block' : 'none';
    ui.panel.style.top = '12px';
    ui.panel.style.left = state.panelSide === 'left' ? '12px' : '';
    ui.panel.style.right = state.panelSide === 'left' ? '' : '12px';
  }

  function setDarkPreview(on) {
    var rootEl = document.documentElement;
    if (on == null) {
      if (state.darkPreview != null) rootEl.classList.toggle('dark', state.darkPreview);
      state.darkPreview = null;
      return;
    }
    if (state.darkPreview == null) state.darkPreview = rootEl.classList.contains('dark');
    rootEl.classList.toggle('dark', on);
  }
  function updateTheme(mutate) {
    endThemePreview();
    var detected = state.detected || (state.detected = detectTheme());
    var item = themeItem();
    if (!item) {
      if (state.items.length >= MAX_ITEMS) { toast('That’s a lot of changes — send these first.'); return; }
      item = { id: uid('t'), kind: 'theme', tweaks: [], theme: { tokens: {}, summary: [] }, createdAt: Date.now() };
      state.items.push(item);
    }
    pushUndo(item);
    mutate(item.theme, detected);
    item.theme.tokens = themeTokens(item.theme, detected);
    item.theme.summary = themeSummary(item.theme);
    commit(item);
  }
  function themePanel() {
    var d = state.detected || (state.detected = detectTheme());
    var item = themeItem(), t = (item && item.theme) || {};
    var body = [];
    if (!d.tailwind) {
      body.push(h('div', { class: 'sec muted', text: 'This app doesn’t use Tailwind theme tokens, so a live preview isn’t available. Describe the look you want and Copilot will restyle it.' }));
    } else {
      var accentFrom = d.accent;
      var accentSec = h('div', { class: 'sec' }, [h('span', { class: 'label', text: 'Accent color' + (accentFrom ? ' · now ' + accentFrom : '') })]);
      if (!accentFrom) accentSec.appendChild(h('div', { class: 'muted', text: 'No accent color detected on this page.' }));
      else {
        var hues = h('div', { class: 'hues' });
        Object.keys(HUES).filter(function (n) { return NEUTRALS.indexOf(n) < 0; }).forEach(function (hue) {
          var on = t.accent ? (!t.accent.hex && t.accent.to === hue) : hue === accentFrom;
          var pickAccent = function (th) { th.accent = hue === accentFrom ? undefined : { from: accentFrom, to: hue }; };
          var sw = h('button', { type: 'button', class: 'swatch' + (on ? ' on' : ''), title: hue, 'aria-label': hue, style: 'background:' + paletteVar(hue, '600'), onclick: function () {
            updateTheme(pickAccent);
          } });
          if (!on) hoverPreview(sw, function () { previewTheme(pickAccent); });
          hues.appendChild(sw);
        });
        accentSec.appendChild(hues);
        var custom = h('input', { type: 'color', title: 'Custom accent', 'aria-label': 'Custom accent', style: 'width:32px;height:24px;border:0;padding:0;background:none' });
        custom.value = t.accent && t.accent.hex ? t.accent.hex : '#4f46e5';
        var customAccent = function (th) { th.accent = { from: accentFrom, to: 'brand', hex: custom.value }; };
        custom.addEventListener('input', function () { previewTheme(customAccent); });
        custom.addEventListener('change', function () { updateTheme(customAccent); });
        custom.addEventListener('blur', endThemePreview);
        accentSec.appendChild(h('div', { class: 'row', style: 'margin-top:6px' }, [h('span', { class: 'muted spacer', text: 'Or pick any color' }), custom]));
      }
      body.push(accentSec);
      if (d.neutral) {
        var pickNeutral = function (v) { return function (th) { th.neutral = v === d.neutral ? undefined : { from: d.neutral, to: v }; }; };
        body.push(h('div', { class: 'sec' }, [
          h('span', { class: 'label', text: 'Neutrals · now ' + d.neutral }),
          seg(NEUTRALS.map(function (n) { return [n, n.charAt(0).toUpperCase() + n.slice(1)]; }), t.neutral ? t.neutral.to : d.neutral, function (v) {
            updateTheme(pickNeutral(v));
          }, function (v) { previewTheme(pickNeutral(v)); })
        ]));
      }
      var pickRadius = function (v) { return function (th) { th.radius = +v === 1 ? undefined : { scale: +v }; }; };
      body.push(h('div', { class: 'sec' }, [
        h('span', { class: 'label', text: 'Corners' }),
        seg(RADIUS_SCALES.map(function (r) { return [String(r[0]), r[1]]; }), String(t.radius ? t.radius.scale : 1), function (v) {
          updateTheme(pickRadius(v));
        }, function (v) { previewTheme(pickRadius(v)); })
      ]));
      var pickDensity = function (v) { return function (th) { th.density = v ? { from: d.spacing || '0.25rem', to: v } : undefined; }; };
      body.push(h('div', { class: 'sec' }, [
        h('span', { class: 'label', text: 'Density' }),
        seg(DENSITIES.map(function (x) { return [x[0], x[1]]; }), t.density ? t.density.to : '', function (v) {
          updateTheme(pickDensity(v));
        }, function (v) { previewTheme(pickDensity(v)); })
      ]));
      body.push(h('div', { class: 'sec' }, [
        selectRow('Font', FONTS.map(function (f) { return [f[0], f[1]]; }), t.font ? t.font.stack : '', function (v) {
          updateTheme(function (th) {
            var f = FONTS.filter(function (x) { return x[0] === v; })[0];
            th.font = v ? { from: d.font || undefined, to: f[1], stack: v } : undefined;
          });
        })
      ]));
      if (d.dark) {
        var modeNow = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
        body.push(h('div', { class: 'sec' }, [
          h('span', { class: 'label', text: 'Preview in' }),
          seg([['light', 'Light'], ['dark', 'Dark']], modeNow, function (v) { setDarkPreview(v === 'dark'); renderPanel(); }),
          h('div', { class: 'note', text: 'Only changes this preview, not your app.' })
        ]));
      }
    }
    var look = h('input', { type: 'text', placeholder: 'Or describe a look…', 'aria-label': 'Describe a look' });
    look.value = t.intent || '';
    var saveLook = function (v) { updateTheme(function (th) { th.intent = v.trim() || undefined; }); };
    look.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveLook(look.value); } });
    look.addEventListener('change', function () { if ((look.value.trim() || undefined) !== t.intent) saveLook(look.value); });
    var presets = h('div', { class: 'chips' });
    INTENTS.forEach(function (s) { presets.appendChild(h('button', { type: 'button', class: 'chip', text: s, onclick: function () { look.value = s; saveLook(s); } })); });
    body.push(h('div', { class: 'sec' }, [h('span', { class: 'label', text: 'Overall look' }), look, presets]));
    var foot = h('div', { class: 'sec row' }, [
      h('span', { class: 'muted spacer', text: item ? 'Theme is in your changes (#' + (itemIndex(item.id) + 1) + ')' : 'Changes preview instantly' }),
      h('button', { type: 'button', class: 'btn', text: 'Reset', disabled: item ? null : true, onclick: function () { if (item) removeItem(item.id); } })
    ]);
    body.push(foot);
    return panelShell('Theme', body);
  }

  function clearSuggestionPreviews() {
    if (!Object.keys(state.previews).length) return;
    state.previews = {};
    compose();
  }
  function toggleSuggestionPreview(s) {
    if (state.previews[s.id]) { delete state.previews[s.id]; compose(); renderPanel(); return; }
    var el = outlineRefs[s.ref];
    if (!el || !el.isConnected) { toast('That element isn’t on the page anymore.'); return; }
    state.previews[s.id] = { el: el, styles: s.styles || {}, rules: s.rules || [] };
    compose();
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    renderPanel();
  }
  function addSuggestion(s) {
    var el = outlineRefs[s.ref];
    if (!el || !el.isConnected) { toast('That element isn’t on the page anymore.'); return false; }
    delete state.previews[s.id];
    if (state.items.length >= MAX_ITEMS) { toast('That’s a lot of changes — send these first.'); return false; }
    var item = newElementItem(el, 'suggestion');
    item.instruction = s.instruction;
    if (s.why) item.why = s.why;
    var css = Object.keys(s.styles || {}).map(function (prop) { return { property: prop, to: s.styles[prop] }; });
    if (css.length || (s.rules && s.rules.length)) item.tweaks.push({ kind: 'variation', summary: 'Preview: ' + s.title, css: css, rules: s.rules && s.rules.length ? s.rules : undefined });
    s.added = item.id;
    project(item);
    state.lastItemId = item.id;
    return true;
  }
  function busyBlock() {
    return h('div', { class: 'sec' }, [
      h('div', { class: 'busy' }, [h('span', { class: 'spin' }), h('span', { class: 'spacer', text: state.busy }), h('span', { class: 'elapsed', 'data-busy-elapsed': '', text: elapsedLabel(state.busySince || Date.now()) })]),
      h('div', { class: 'note', 'data-busy-hint': '', role: 'status', 'aria-live': 'polite', text: busyHint() })
    ]);
  }
  function polishPanel() {
    var body = [];
    if (state.busy) body.push(busyBlock());
    else if (!state.suggestions.length) body.push(h('div', { class: 'sec muted', text: state.suggestionMessage || 'No suggestions yet.' }));
    state.suggestions.forEach(function (s) {
      var added = s.added && itemById(s.added);
      var previewing = !!state.previews[s.id];
      body.push(h('div', { class: 'sugg' }, [
        h('div', { class: 't', text: s.title }),
        s.why ? h('div', { class: 'w', text: s.why }) : null,
        h('div', { class: 'row' }, [
          (s.styles && Object.keys(s.styles).length) || (s.rules && s.rules.length)
            ? h('button', { type: 'button', class: 'btn' + (previewing ? ' primary' : ''), text: previewing ? 'Previewing' : 'Preview', 'aria-pressed': previewing ? 'true' : 'false', disabled: added ? true : null, onclick: function () { toggleSuggestionPreview(s); } })
            : h('span', { class: 'muted', text: 'Copilot will make this change' }),
          h('span', { class: 'spacer' }),
          added
            ? h('span', { class: 'muted', html: svgIcon('check').replace('<svg', '<svg style="width:14px;height:14px;vertical-align:-3px"') + ' Added' })
            : h('button', { type: 'button', class: 'btn primary', text: 'Add', onclick: function () { if (addSuggestion(s)) { bump(); renderPanel(); } } })
        ])
      ]));
    });
    var pending = state.suggestions.filter(function (s) { return !(s.added && itemById(s.added)); });
    if (pending.length > 1) {
      body.push(h('div', { class: 'sec row end' }, [h('button', { type: 'button', class: 'btn primary', text: 'Add all ' + pending.length, onclick: function () {
        pending.forEach(addSuggestion);
        bump();
        renderPanel();
      } })]));
    }
    return panelShell('Polish suggestions', body);
  }

  function renderBanner() {
    if (!ui.banner) return;
    ui.banner.textContent = '';
    ui.banner.className = '';
    if (!state.busy || state.panel === 'polish') return;
    ui.banner.className = 'banner surface';
    ui.banner.appendChild(h('span', { class: 'spin' }));
    ui.banner.appendChild(h('span', { text: state.busy }));
    ui.banner.appendChild(h('span', { class: 'elapsed', 'data-busy-elapsed': '', text: elapsedLabel(state.busySince || Date.now()) }));
  }
  function renderIntro() {
    if (!ui.intro) return;
    ui.intro.textContent = '';
    ui.intro.className = '';
    if (!state.intro) return;
    ui.intro.className = 'intro surface';
    ui.intro.appendChild(h('p', null, [h('b', { text: 'Click anything in your app to change it.' })]));
    ui.intro.appendChild(h('p', { class: 'muted', text: 'Say what you want or use quick tweaks — each change queues up in the chat. Hold Alt to use your app normally.' }));
    ui.intro.appendChild(h('div', { class: 'row end' }, [h('button', { type: 'button', class: 'btn primary', text: 'Got it', onclick: function () { state.intro = false; renderIntro(); } })]));
  }

  // ---- positioning (one rAF loop while Design is on) ---------------------------
  function place(node, r, pad) {
    if (!r || (!r.width && !r.height)) { node.style.display = 'none'; return; }
    pad = pad || 0;
    node.style.display = 'block';
    node.style.left = (r.left - pad) + 'px';
    node.style.top = (r.top - pad) + 'px';
    node.style.width = (r.width + pad * 2) + 'px';
    node.style.height = (r.height + pad * 2) + 'px';
  }
  function positionHover() {
    var el = state.hover;
    if (!el || !el.isConnected || (state.selected && state.selected.el === el)) { ui.hover.style.display = 'none'; ui.tag.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    place(ui.hover, r);
    ui.tag.textContent = state.hoverLabel;
    ui.tag.style.display = 'block';
    ui.tag.style.left = clamp(r.left, 4, Math.max(4, window.innerWidth - 220)) + 'px';
    ui.tag.style.top = (r.top > 28 ? r.top - 24 : Math.min(window.innerHeight - 24, r.bottom + 4)) + 'px';
  }
  function positionSelection() {
    var sel = state.selected;
    if (!sel || !sel.el.isConnected) { ui.sel.style.display = 'none'; ui.similar.textContent = ''; return; }
    place(ui.sel, sel.el.getBoundingClientRect(), 2);
    var sims = sel.similarOn ? sel.similar : [];
    while (ui.similar.children.length < sims.length) ui.similar.appendChild(h('div', { class: 'box sim' }));
    while (ui.similar.children.length > sims.length) ui.similar.removeChild(ui.similar.lastChild);
    sims.forEach(function (s, i) { place(ui.similar.children[i], s.isConnected ? s.getBoundingClientRect() : null, 1); });
  }
  function positionPins() {
    var pins = ui.pins, n = 0;
    state.items.forEach(function (item, i) {
      if (item.kind === 'theme') return;
      var pin = pins.children[n];
      if (!pin) {
        pin = h('div', { class: 'pin', role: 'button', tabindex: '0' });
        pin.addEventListener('click', function (e) { e.stopPropagation(); focusItem(pin.__id); });
        pins.appendChild(pin);
      }
      n++;
      pin.__id = item.id;
      if (pin.textContent !== String(i + 1)) pin.textContent = String(i + 1);
      pin.title = 'Change ' + (i + 1) + ': ' + ((item.target && item.target.label) || '');
      var p = proj[item.id], el = p && p.el;
      var r = el && el.isConnected ? el.getBoundingClientRect() : null;
      if (!r || (!r.width && !r.height) || r.bottom < 0 || r.top > window.innerHeight) { pin.style.display = 'none'; return; }
      pin.style.display = 'flex';
      pin.style.left = r.left + 'px';
      pin.style.top = r.top + 'px';
    });
    while (pins.children.length > n) pins.removeChild(pins.lastChild);
  }
  function positionCard() {
    var sel = state.selected;
    if (!sel || !ui.card || ui.card.style.display === 'none') return;
    var r = sel.el.isConnected ? sel.el.getBoundingClientRect() : null;
    if (r && (r.width || r.height)) sel.lastRect = r; else r = sel.lastRect;
    var box = ui.card.getBoundingClientRect(), cw = box.width || 312, ch = box.height || 240;
    var vw = window.innerWidth, vh = window.innerHeight, gap = 12, left, top;
    var avoid = state.panel && ui.panel && ui.panel.getBoundingClientRect();
    var docked = avoid && avoid.width, onLeft = state.panelSide === 'left';
    var leftEdge = docked && onLeft ? avoid.right + 8 : 8;
    var rightEdge = docked && !onLeft ? avoid.left - 8 : vw - 8;
    if (!r) { left = rightEdge - cw; top = gap; }
    else if (r.right + gap + cw <= rightEdge) { left = r.right + gap; top = r.top; }
    else if (r.left - gap - cw >= leftEdge) { left = r.left - gap - cw; top = r.top; }
    else if (r.bottom + gap + ch <= vh - 8) { left = r.left; top = r.bottom + gap; }
    else { left = r.left; top = r.top - gap - ch; }
    left = clamp(left, leftEdge, Math.max(leftEdge, rightEdge - cw));
    top = clamp(top, 8, Math.max(8, vh - ch - 8));
    ui.card.style.left = Math.round(left) + 'px';
    ui.card.style.top = Math.round(top) + 'px';
  }

  var rafId = 0, lastCheck = 0, staleDirty = false;
  function frame() {
    rafId = 0;
    if (!state.enabled || !host) return;
    if (!state.capturing) {
      positionHover();
      positionSelection();
      positionPins();
      positionCard();
    }
    var now = Date.now();
    if (now - lastCheck > 400) { lastCheck = now; checkPage(); updateProgress(); }
    rafId = requestAnimationFrame(frame);
  }
  /** Notice SPA navigations and re-renders: re-anchor items and keep the card on a live element. */
  function checkPage() {
    var r = route();
    if (r !== state.lastRoute) {
      state.lastRoute = r;
      closeCard();
      clearSuggestionPreviews();
      staleDirty = true;
    }
    if (staleDirty) { staleDirty = false; reprojectStale(); }
    var sel = state.selected;
    if (sel && !sel.el.isConnected) {
      var item = currentItem(), p = item && proj[item.id];
      if (p && p.el && p.el.isConnected) { sel.el = p.el; sel.similar = similarOf(p.el); }
      else closeCard();
    }
    if (state.hover && !state.hover.isConnected) state.hover = null;
  }

  // ---- input -------------------------------------------------------------------------
  var BLOCKED = ['click', 'dblclick', 'mousedown', 'mouseup', 'auxclick', 'contextmenu', 'pointerup', 'submit'];
  function setHover(el) {
    if (state.hover === el) return;
    state.hover = el;
    state.hoverLabel = el ? labelOf(el) : '';
  }
  function onPointerMove(e) {
    if (state.capturing || e.altKey || inOurUi(e)) { setHover(null); return; }
    setHover(pick(e.target));
  }
  function onPointerDown(e) {
    if (inOurUi(e) || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0) return;
    var el = pick(e.target);
    if (state.intro) { state.intro = false; renderIntro(); }
    if (!el) { closeCard(); return; }
    if (state.selected && state.selected.el === el) return;
    openCard(el);
  }
  function blockEvent(e) {
    if (inOurUi(e) || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
  }
  function onDblClick(e) {
    if (inOurUi(e) || e.altKey) return;
    var el = pick(e.target);
    if (el && textHost(el) && roleOf(el) !== 'chart') {
      if (!state.selected || state.selected.el !== el) openCard(el, 'text');
      else { state.selected.tool = 'text'; state.selected.focusTool = true; renderCard(); positionCard(); }
    }
  }
  function onKeyDown(e) {
    if (inOurUi(e)) {
      var t = e.composedPath ? e.composedPath()[0] : e.target;
      if (e.key === 'Escape' && !(t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
        e.preventDefault();
        if (state.selected) closeCard(); else if (state.panel) closePanel();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (state.selected) { e.preventDefault(); closeCard(); }
      else if (state.panel) { e.preventDefault(); closePanel(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      var it = state.lastItemId && itemById(state.lastItemId);
      if (it) { e.preventDefault(); e.stopPropagation(); undo(it); }
    }
  }

  function focusItem(id) {
    var item = itemById(id);
    if (!item) return;
    if (item.kind === 'theme') { openPanel('theme'); return; }
    var p = proj[id];
    var el = p && p.el && p.el.isConnected ? p.el : anchor(item);
    if (!el) { toast('That change is on another page' + (item.target && item.target.route ? ' (' + item.target.route + ')' : '') + '.'); return; }
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    openCard(el);
  }
  function showSuggestions(list, message) {
    clearSuggestionPreviews();
    state.suggestions = (Array.isArray(list) ? list : []).slice(0, 8).filter(function (s) { return s && typeof s === 'object'; }).map(function (s) {
      var c = cloneVal(s);
      c.styles = safeStyles(c.styles);
      c.rules = safeRules(c.rules);
      return c;
    });
    state.suggestionMessage = message || '';
    state.busy = null;
    state.panel = 'polish';
    renderBanner();
    renderPanel();
    bump();
  }

  // ---- Polish: page outline + deterministic findings ------------------------------
  function visibleEnough(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    if (r.bottom < 0 || r.top > window.innerHeight * 2) return false;
    var cs = getComputedStyle(el), opacity = parseFloat(cs.opacity);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && (isNaN(opacity) || opacity > 0.05);
  }
  function pickStyles(cs) {
    var out = {};
    ['color', 'background-color', 'font-size', 'font-weight', 'padding', 'border-radius', 'box-shadow', 'gap'].forEach(function (p) {
      var v = (cs.getPropertyValue(p) || '').trim();
      if (v && v !== 'none' && v !== 'normal' && v !== '0px' && !(p === 'background-color' && isTransparent(v))) out[p] = clip(v, 80);
    });
    return out;
  }
  function collectPage() {
    outlineRefs = {};
    var elements = [], seen = [], n = 0;
    function add(el) {
      if (elements.length >= 60 || seen.indexOf(el) >= 0 || isOurs(el) || !visibleEnough(el)) return;
      var role = roleOf(el);
      if (role === 'container' || role === 'element') return;
      if (role !== 'chart' && chartRoot(el)) return;
      if (role === 'icon' && el.closest('button,a')) return;
      if (role === 'text' && ownText(el).length < 12) return;
      seen.push(el);
      var ref = 'r' + (++n), r = el.getBoundingClientRect();
      outlineRefs[ref] = el;
      elements.push({
        ref: ref, label: labelOf(el), role: role, tag: el.tagName.toLowerCase(),
        text: clip(ownText(el) || readableText(el), 60) || undefined,
        classes: clip(el.getAttribute('class') || '', 160) || undefined,
        styles: pickStyles(getComputedStyle(el)),
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
      });
    }
    var body = document.body;
    if (body) {
      var first = body.querySelectorAll('h1,h2,h3,h4,button,a,[role="button"],input,select,textarea,img,[data-graphein-spec],nav,header,footer,table');
      for (var i = 0; i < first.length && i < 2500; i++) add(chartRoot(first[i]) || first[i]);
      var rest = body.querySelectorAll('div,section,article,li,p');
      for (var j = 0; j < rest.length && j < 4000 && elements.length < 60; j++) {
        var el = rest[j], role = null;
        if (el.tagName === 'P') role = 'text';
        else { try { if (looksLikeCard(el, getComputedStyle(el))) role = 'card'; } catch (e) {} }
        if (role) add(el);
      }
    }
    return { route: route(), title: clip(document.title || '', 120), viewport: viewport(), elements: elements, findings: findings(elements) };
  }
  function findings(elements) {
    var out = [], radii = {};
    elements.forEach(function (e) {
      var el = outlineRefs[e.ref];
      if (!el || out.length >= 24) return;
      var cs = getComputedStyle(el);
      if (/^(text|heading|button|link|item|field)$/.test(e.role) && (ownText(el) || e.role === 'button')) {
        var fg = parseColor(cs.color), bg = effectiveBackground(el);
        if (fg && bg) {
          var size = parseFloat(cs.fontSize) || 16, weight = parseInt(cs.fontWeight, 10) || 400;
          var large = size >= 24 || (size >= 18.6 && weight >= 700), need = large ? 3 : 4.5;
          var ratio = contrastRatio(fg, bg);
          if (ratio < need) out.push({ ref: e.ref, kind: 'contrast', message: 'Text contrast is ' + ratio.toFixed(1) + ':1 (needs ' + need + ':1)' });
        }
      }
      if (/^(button|link|field)$/.test(e.role) && (e.rect.w < 24 || e.rect.h < 24)) out.push({ ref: e.ref, kind: 'tap-target', message: 'Small click target (' + e.rect.w + '×' + e.rect.h + ' px)' });
      if (e.role === 'card') { var rad = cs.borderTopLeftRadius; radii[rad] = (radii[rad] || 0) + 1; }
      if (e.tag === 'p') {
        var chars = e.rect.w / ((parseFloat(cs.fontSize) || 16) * 0.5);
        if (chars > 95) out.push({ ref: e.ref, kind: 'line-length', message: 'Long lines (about ' + Math.round(chars) + ' characters) are hard to read' });
      }
    });
    var distinct = Object.keys(radii);
    if (distinct.length >= 3) out.push({ kind: 'radius', message: 'Cards use ' + distinct.length + ' different corner radii (' + distinct.join(', ') + ')' });
    var over = document.documentElement.scrollWidth - window.innerWidth;
    if (over > 1) out.push({ kind: 'overflow', message: 'The page scrolls sideways at this width (by ' + over + ' px)' });
    return out.slice(0, 24);
  }

  // ---- capture prep (the host screenshots the page, then crops each item) --------
  var captureTimer = 0, captureDark = null;
  function viewport() { return { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 }; }
  function prepareCapture(requestId, ids) {
    endPreviews();
    hovered = null;
    // Only queued changes belong in the screenshot: compose() leaves out Polish
    // previews while capturing, and the light/dark preview goes back to the app's own.
    state.capturing = true;
    compose();
    var rootEl = document.documentElement;
    if (state.darkPreview != null && !captureDark) {
      captureDark = { on: rootEl.classList.contains('dark') };
      rootEl.classList.toggle('dark', state.darkPreview);
    }
    if (ui.layer) ui.layer.classList.add('capturing');
    var rects = {};
    (Array.isArray(ids) && ids.length ? ids : state.items.map(function (i) { return i.id; })).forEach(function (id) {
      var item = itemById(id), p = proj[id];
      if (!item || item.kind === 'theme' || !p || !p.el || !p.el.isConnected) return;
      var r = p.el.getBoundingClientRect();
      var x = Math.max(0, r.left), y = Math.max(0, r.top);
      var x2 = Math.min(window.innerWidth, r.right), y2 = Math.min(window.innerHeight, r.bottom);
      if (x2 - x >= 2 && y2 - y >= 2) rects[id] = { x: Math.round(x), y: Math.round(y), w: Math.round(x2 - x), h: Math.round(y2 - y) };
    });
    putResult(requestId, { viewport: viewport(), frame: isTop ? { x: 0, y: 0 } : null, rects: rects });
    clearTimeout(captureTimer);
    captureTimer = setTimeout(endCapture, 5000);
  }
  function endCapture() {
    clearTimeout(captureTimer);
    if (!state.capturing) return;
    state.capturing = false;
    if (captureDark) {
      if (state.darkPreview != null) document.documentElement.classList.toggle('dark', captureDark.on);
      captureDark = null;
    }
    if (ui.layer) ui.layer.classList.remove('capturing');
    compose();
  }

  // ---- local controller API ---------------------------------------------------------
  var mo = null;
  function putResult(id, value) {
    if (!id) return;
    state.results[id] = value;
    state.resultTimes[id] = Date.now();
    bump();
  }
  function expireResults() {
    var now = Date.now();
    for (var id in state.resultTimes) {
      if (now - state.resultTimes[id] > 15000) { delete state.results[id]; delete state.resultTimes[id]; }
    }
    state.requests.slice().forEach(function (r) {
      if (now - (requestTimes[r.id] || now) > 90000) { delete requestTimes[r.id]; onRequestFailed(r.id, 'No options after 90 seconds — the model may be busy. Try again, or describe the change above and press Add.'); }
    });
  }
  function setHostTheme(theme) {
    if (!theme) return;
    state.hostTheme = theme;
    state.hasTheme = true;
    applyChrome();
    bump();
  }
  function enableLocal(options) {
    if (!state.enabled) {
      state.enabled = true;
      buildChrome();
      window.addEventListener('pointermove', onPointerMove, true);
      window.addEventListener('pointerdown', onPointerDown, true);
      BLOCKED.forEach(function (t) { window.addEventListener(t, blockEvent, true); });
      window.addEventListener('dblclick', onDblClick, true);
      window.addEventListener('keydown', onKeyDown, true);
      try {
        mo = new MutationObserver(function () { staleDirty = true; });
        mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
      } catch (e) { mo = null; }
      state.lastRoute = route();
      rafId = requestAnimationFrame(frame);
    }
    if (options) {
      if (options.hostTheme) setHostTheme(options.hostTheme);
      if (options.sessionId) seedItems(options.sessionId, options.items || []);
      state.intro = !!options.intro;
    }
    renderIntro();
    renderPanel();
    renderBanner();
    bump();
  }
  function disableLocal() {
    if (!state.enabled) return;
    closeCard();
    clearSuggestionPreviews();
    setDarkPreview(null);
    endCapture();
    restoreAll();
    removeThemeStyle();
    themePreviewing = false;
    hoverHold = hovered = null;
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
    BLOCKED.forEach(function (t) { window.removeEventListener(t, blockEvent, true); });
    window.removeEventListener('dblclick', onDblClick, true);
    window.removeEventListener('keydown', onKeyDown, true);
    if (mo) { mo.disconnect(); mo = null; }
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    destroyChrome();
    state.enabled = false;
    state.sessionId = null;
    state.items = [];
    proj = {};
    outlineRefs = {};
    state.panel = null;
    state.busy = null;
    state.requests = [];
    state.results = {};
    state.resultTimes = {};
    state.suggestions = [];
    state.hover = null;
    state.intro = false;
    bump();
  }
  function localPeek() {
    expireResults();
    return {
      enabled: state.enabled,
      sessionId: state.sessionId,
      version: state.version,
      hasTheme: state.hasTheme,
      itemCount: state.items.length,
      requests: cloneVal(state.requests),
      results: cloneVal(state.results),
      panel: state.panel
    };
  }
  function localSnapshot() {
    if (!state.enabled) return null;
    return { version: state.version, sessionId: state.sessionId, route: route(), viewport: viewport(), items: state.items.map(serializeItem) };
  }
  function localCommand(cmd) {
    if (!cmd || typeof cmd.op !== 'string') return { accepted: false };
    if (!state.enabled) return { accepted: false };
    switch (cmd.op) {
      case 'seed': seedItems(cmd.sessionId, cmd.items); break;
      case 'removeItem': removeItem(cmd.id); break;
      case 'focusItem': focusItem(cmd.id); break;
      case 'clear': clearItems(); break;
      case 'openPanel': if (cmd.panel) openPanel(cmd.panel); else closePanel(); break;
      case 'applyVariations': onVariations(cmd.requestId, cmd.options); break;
      case 'failRequest': onRequestFailed(cmd.requestId, cmd.message); break;
      case 'collectPage': putResult(cmd.requestId, collectPage()); break;
      case 'showSuggestions': showSuggestions(cmd.suggestions, cmd.message); break;
      case 'setBusy':
        if (cmd.message && !state.busy) state.busySince = Date.now();
        state.busy = cmd.message || null;
        if (!state.busy) state.busySince = 0;
        renderBanner();
        if (state.busy && cmd.panel !== false) openPanel('polish'); else renderPanel();
        bump();
        break;
      case 'requestProgress': onRequestProgress(cmd.requestId, cmd.message); break;
      case 'prepareCapture': prepareCapture(cmd.requestId, cmd.ids); break;
      case 'endCapture': endCapture(); bump(); break;
      default: return { accepted: false };
    }
    return { accepted: true };
  }

  // ---- frame roles + the Fabric relay -------------------------------------------
  // The host only evals in the TOP frame. When the app is embedded in a
  // cross-origin iframe (Fabric portal), the top frame runs as a `relay`: it
  // forwards enable / command / theme to the app frame over postMessage
  // (origin-gated to the deployed app) and mirrors its status + snapshot back.
  var frameRole = 'idle'; // 'idle' | 'direct' | 'relay' | 'app'
  var isTop = true;
  try { isTop = window.top === window.self; } catch (e) { isTop = true; }

  var relay = { active: false, appWin: null, appOrigin: null, session: null, seed: null, theme: null, status: null, snapshot: null, hellos: [], pingTimer: 0, pingCount: 0 };
  function postToApp(msg) {
    msg.ns = MSG;
    try { if (relay.appWin && relay.appOrigin) relay.appWin.postMessage(msg, relay.appOrigin); } catch (e) {}
  }
  /** What the app frame needs to (re)start: our session plus the latest mirrored items. */
  function relaySeed() {
    var items = relay.snapshot && relay.snapshot.items ? relay.snapshot.items : (relay.seed && relay.seed.items) || [];
    var out = { sessionId: relay.session, items: items, hostTheme: relay.theme || undefined, intro: !!(relay.seed && relay.seed.intro) };
    if (relay.seed) relay.seed.intro = false;
    return out;
  }
  function relayConnect() { postToApp({ cmd: 'enable', options: relay.session ? relaySeed() : (relay.theme ? { hostTheme: relay.theme } : null) }); }
  function stopPing() { if (relay.pingTimer) { clearTimeout(relay.pingTimer); relay.pingTimer = 0; } }
  // The relay can't enumerate deeply nested cross-origin frames, so it pings its
  // direct children (origin-gated) to prompt a hello.
  function pingChildren() {
    stopPing();
    relay.pingCount = 0;
    (function tick() {
      if (!relay.active || relay.appWin) { stopPing(); return; }
      try { for (var i = 0; i < window.frames.length; i++) { try { window.frames[i].postMessage({ ns: MSG, cmd: 'ping' }, relay.appOrigin || '*'); } catch (e) {} } } catch (e) {}
      if (++relay.pingCount >= 10) { stopPing(); return; }
      relay.pingTimer = setTimeout(tick, 500);
    })();
  }
  function relayEnable(origin, options) {
    frameRole = 'relay';
    relay.active = true;
    relay.appOrigin = origin || null;
    if (options) {
      relay.session = options.sessionId || null;
      relay.seed = cloneVal(options);
      relay.snapshot = null;
      relay.status = null;
      if (options.hostTheme) relay.theme = options.hostTheme;
    }
    for (var i = 0; i < relay.hellos.length; i++) if (relay.hellos[i].origin === relay.appOrigin) relay.appWin = relay.hellos[i].source;
    relay.hellos = [];
    if (relay.appWin) relayConnect();
    pingChildren();
  }
  function relayDisable() {
    postToApp({ cmd: 'disable' });
    relay.active = false;
    relay.status = relay.snapshot = relay.seed = null;
    relay.session = null;
    stopPing();
    frameRole = 'idle';
  }
  /** Where the app iframe sits inside this (top) window — `null` when it's nested deeper. */
  function frameOffset() {
    var frames = document.getElementsByTagName('iframe');
    for (var i = 0; i < frames.length; i++) {
      try {
        if (frames[i].contentWindow !== relay.appWin) continue;
        var r = frames[i].getBoundingClientRect(), cs = getComputedStyle(frames[i]);
        return { x: r.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0), y: r.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0) };
      } catch (e) {}
    }
    return null;
  }
  function relayPeek() {
    if (relay.status) {
      var s = cloneVal(relay.status);
      for (var id in s.results || {}) {
        var r = s.results[id];
        if (r && r.rects) { r.frame = frameOffset(); r.viewport = viewport(); }
      }
      return s;
    }
    return { enabled: relay.active, sessionId: relay.session, version: 0, hasTheme: !!relay.theme, itemCount: 0, requests: [], results: {}, panel: null };
  }
  function relaySnapshot() { return relay.snapshot && relay.snapshot.version != null ? cloneVal(relay.snapshot) : null; }
  function relayCommand(cmd) {
    if (!cmd || typeof cmd.op !== 'string') return { accepted: false };
    if (cmd.op === 'seed') { relay.session = cmd.sessionId || null; relay.snapshot = { items: cmd.items || [] }; }
    postToApp({ cmd: 'command', command: cmd });
    return { accepted: !!relay.appWin };
  }
  function relaySetTheme(theme) {
    relay.theme = theme || null;
    postToApp({ cmd: 'theme', theme: theme });
  }

  // App side (the embedded iframe).
  var appSide = { topOrigin: null, acked: false, syncTimer: 0, pending: 0 };
  // The only legitimate relay is the Fabric (or Power BI) portal hosting the app.
  // Any other top-level page could frame a site and use this controller to read
  // or restyle it, so the app side only talks to portal origins.
  var RELAY_HOSTS = /(^|\.)(fabric\.microsoft\.(com|us|cn)|powerbi\.com|powerbigov\.us|powerbi\.cn)$/i;
  function trustedRelay(origin) {
    try { var u = new URL(origin); return u.protocol === 'https:' && RELAY_HOSTS.test(u.hostname); } catch (e) { return false; }
  }
  /** The top frame's origin when the browser reports it (`location.ancestorOrigins`). */
  function topOrigin() {
    try { var a = location.ancestorOrigins; return a && a.length ? a[a.length - 1] : null; } catch (e) { return null; }
  }
  function sayHello() {
    if (isTop) return;
    var top = topOrigin();
    if (top && !trustedRelay(top)) return;
    try { window.top.postMessage({ ns: MSG, evt: 'hello' }, top || '*'); } catch (e) {}
  }
  function scheduleHellos() {
    if (isTop) return;
    [0, 250, 750, 1500, 3000, 6000].forEach(function (ms) { setTimeout(function () { if (!appSide.acked) sayHello(); }, ms); });
    try {
      document.addEventListener('DOMContentLoaded', function () { if (!appSide.acked) sayHello(); });
      window.addEventListener('load', function () { if (!appSide.acked) sayHello(); });
    } catch (e) {}
  }
  function postState() {
    if (isTop || frameRole !== 'app' || !appSide.topOrigin) return;
    try { window.top.postMessage({ ns: MSG, evt: 'state', status: localPeek(), snapshot: localSnapshot() }, appSide.topOrigin); } catch (e) {}
  }
  function scheduleSync() {
    if (frameRole !== 'app' || appSide.pending) return;
    appSide.pending = setTimeout(function () { appSide.pending = 0; postState(); }, 30);
  }
  function startAppSync() { stopAppSync(); appSide.syncTimer = setInterval(postState, 1000); }
  function stopAppSync() { if (appSide.syncTimer) { clearInterval(appSide.syncTimer); appSide.syncTimer = 0; } }
  function onRelayCommand(d, e) {
    appSide.topOrigin = e.origin || null;
    appSide.acked = true;
    switch (d.cmd) {
      case 'ping': sayHello(); break;
      case 'enable': frameRole = 'app'; enableLocal(d.options || null); startAppSync(); postState(); break;
      case 'disable': disableLocal(); postState(); stopAppSync(); frameRole = 'idle'; break;
      case 'command': localCommand(d.command); postState(); break;
      case 'theme': setHostTheme(d.theme); postState(); break;
    }
  }
  function onMessage(e) {
    var d = e && e.data;
    if (!d || d.ns !== MSG) return;
    if (isTop) {
      if (frameRole === 'direct' || frameRole === 'app') return;
      if (d.evt === 'hello') {
        if (relay.appOrigin) {
          if (e.origin === relay.appOrigin) { relay.appWin = e.source; if (relay.active) relayConnect(); }
        } else {
          relay.hellos.push({ source: e.source, origin: e.origin });
          if (relay.hellos.length > 12) relay.hellos.shift();
        }
      } else if (d.evt === 'state' && frameRole === 'relay' && e.origin === relay.appOrigin && e.source === relay.appWin) {
        relay.status = d.status || null;
        if (d.snapshot) relay.snapshot = d.snapshot;
      }
    } else if (d.cmd) {
      var fromTop = false;
      try { fromTop = e.source === window.top; } catch (err) { fromTop = false; }
      if (fromTop && trustedRelay(e.origin)) onRelayCommand(d, e);
    }
  }

  // ---- public API ------------------------------------------------------------------
  function hostEnable(mode, appOrigin, options) {
    if (mode === 'relay') { relayEnable(appOrigin, options || null); return; }
    frameRole = 'direct';
    enableLocal(options || null);
  }
  function hostDisable() {
    if (frameRole === 'relay') relayDisable();
    else { disableLocal(); frameRole = 'idle'; }
  }
  window[NS] = {
    __v: VERSION,
    enable: function (mode, appOrigin, options) { try { hostEnable(mode, appOrigin, options); } catch (e) {} },
    disable: function () { try { hostDisable(); } catch (e) {} },
    peek: function () { try { return frameRole === 'relay' ? relayPeek() : localPeek(); } catch (e) { return null; } },
    snapshot: function () { try { return frameRole === 'relay' ? relaySnapshot() : localSnapshot(); } catch (e) { return null; } },
    command: function (cmd) { try { return frameRole === 'relay' ? relayCommand(cmd) : localCommand(cmd); } catch (e) { return { accepted: false }; } },
    setTheme: function (theme) { try { if (frameRole === 'relay') relaySetTheme(theme); else setHostTheme(theme); } catch (e) {} },
    // Pure helpers, exposed for unit tests.
    __test: {
      convert: { chartTypes: CHART_TYPES, groups: TYPE_GROUPS, shapeOf: shapeOf, canConvert: canConvert, convertSpec: convertSpec },
      roleOf: roleOf,
      labelOf: labelOf,
      pick: pick,
      describe: describe,
      detectTheme: detectTheme,
      themeTokens: themeTokens,
      parseColor: parseColor,
      contrastRatio: contrastRatio,
      rgbToOklch: rgbToOklch,
      oklchToRgb: oklchToRgb,
      chartSummary: chartSummary,
      openCard: function (el, tool) { openCard(el, tool); },
      card: function () { return ui.card || null; },
      panel: function () { return ui.panel || null; },
      shadow: function () { return root; }
    }
  };
  window.addEventListener('message', onMessage);
  if (!isTop) scheduleHellos();
})();

