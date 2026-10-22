// ESLint plugin `medlevo-css` — AOS-20.1 (track C3): «New screens use only design-system tokens and components»,
// as a LINT rule over the web app's CSS, so a colour written by hand fails `npm run lint` in the editor and in CI.
//
//   * language `medlevo-css/css` — a minimal text language for .css files: the whole stylesheet is one node
//     (`Stylesheet`); the rule reads its text. (No CSS parser dependency: the rule only needs declarations.)
//   * rule `medlevo-css/token-colors` — inside declarations, a colour must come from the design tokens
//     (`var(--ml-…)`, defined in apps/web/src/design/tokens.css) or be one of the CSS keywords that carry no colour of
//     their own (`currentColor`, `transparent`, `inherit`, `initial`, `unset`, `revert`, `none`). Reported: hex colours,
//     colour functions (`rgb()`, `rgba()`, `hsl()`, `hsla()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`,
//     `color()`), and named colours (`white`, `black`, `red`, …) in colour-carrying properties. Comments and quoted
//     strings are ignored.
// Scope (eslint.config.js): every CSS file of apps/web/src — so any NEW stylesheet is covered from its first line —
// except the token file itself. The stylesheets written before the Academic OS still hold hand-written colours: they
// are FROZEN, not exempt (C3 review R3 — new AOS rules keep landing in them, components.css first of all): option
// `frozen` maps each such file to the colours it holds today with their counts (tools/eslint/design-tokens.frozen.json),
// and any colour beyond that — a new one, or one more of the same — fails like anywhere else. A new token is added to
// tokens.css (light, dark, e-ink) and used by name.
import { relative, sep } from 'node:path';
import { TextSourceCodeBase, VisitNodeStep } from '@eslint/plugin-kit';

class StylesheetSourceCode extends TextSourceCodeBase {
  constructor({ text, ast }) {
    super({ text, ast });
    this.ast = ast;
  }
  getLoc(node) {
    return node.loc;
  }
  getRange(node) {
    return node.range;
  }
  getParent() {
    return undefined;
  }
  traverse() {
    return [new VisitNodeStep({ target: this.ast, phase: 1, args: [this.ast, null] }), new VisitNodeStep({ target: this.ast, phase: 2, args: [this.ast, null] })];
  }
}

/** @type {import('eslint').Linter.Config['language'] extends infer L ? any : never} */
const cssText = {
  fileType: 'text',
  lineStart: 1,
  columnStart: 0,
  nodeTypeKey: 'type',
  visitorKeys: { Stylesheet: [] },
  validateLanguageOptions() {},
  parse(file) {
    const text = typeof file.body === 'string' ? file.body : new TextDecoder().decode(file.body);
    const lines = text.split(/\r?\n/);
    const last = lines[lines.length - 1] ?? '';
    return {
      ok: true,
      ast: { type: 'Stylesheet', range: [0, text.length], loc: { start: { line: 1, column: 0 }, end: { line: lines.length, column: last.length } } },
    };
  },
  createSourceCode(file, parseResult) {
    const text = typeof file.body === 'string' ? file.body : new TextDecoder().decode(file.body);
    return new StylesheetSourceCode({ text, ast: parseResult.ast });
  },
};

/** CSS named colours (CSS Color 4) — reported only in colour-carrying properties. */
const NAMED = new Set(
  'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(
    ' ',
  ),
);

/** Properties whose value carries a colour (named colours are checked only there; hex and functions everywhere). */
// (C3 review) also the masks, border images and the -webkit- shadow, where a named colour drew a gradient unseen
const COLOUR_PROPERTY = /^(?:--.*|color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?(?:-color)?|border-image(?:-source)?|outline(?:-color)?|fill|stroke|(?:-webkit-)?(?:box|text)-shadow|(?:-webkit-)?mask(?:-image)?|text-decoration(?:-color)?|text-emphasis(?:-color)?|caret-color|accent-color|column-rule(?:-color)?|scrollbar-color|filter|backdrop-filter|stop-color|flood-color|lighting-color|-webkit-tap-highlight-color|-webkit-text-fill-color|-webkit-text-stroke(?:-color)?)$/i;

const HEX = /#[0-9a-f]{3,8}\b/gi;
const FUNC = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;
const WORD = /-?[a-z][a-z-]*/gi;

/** The text with comments and quoted strings blanked (same length, so offsets stay true). */
function blank(text) {
  return text.replace(/\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => m.replace(/[^\n]/g, ' '));
}

const tokenColors = {
  meta: {
    type: 'problem',
    docs: { description: 'Colours in CSS come from the design tokens (AOS-20.1)' },
    messages: {
      literal: 'Colour «{{value}}» is written by hand: use a design token (var(--ml-…), apps/web/src/design/tokens.css) — AOS-20.1.',
      frozen:
        'Colour «{{value}}» is written by hand in a frozen pre-AOS stylesheet beyond the colours it already held: use a design token (var(--ml-…), apps/web/src/design/tokens.css) — AOS-20.1.',
    },
    schema: [
      {
        type: 'object',
        properties: { frozen: { type: 'object', additionalProperties: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } } } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const source = context.sourceCode;
    const rel = relative(context.cwd, context.filename).split(sep).join('/');
    const held = context.options[0]?.frozen?.[rel];
    // what a frozen file may still hold (value → count); every literal beyond it is reported
    const allowance = new Map(Object.entries(held ?? {}).map(([k, n]) => [k.toLowerCase(), n]));
    return {
      Stylesheet() {
        const text = blank(source.text);
        // declarations: «property: value» up to ; or } (selectors never contain «:» followed by a value and «;»)
        const decl = /([-a-zA-Z_][-a-zA-Z0-9_]*)\s*:\s*([^;{}]*)(?=[;}])/g;
        for (let m = decl.exec(text); m; m = decl.exec(text)) {
          const prop = m[1];
          const value = m[2];
          const at = m.index + m[0].length - value.length;
          const report = (index, found) => {
            const key = found.toLowerCase();
            const left = allowance.get(key) ?? 0;
            if (left > 0) {
              allowance.set(key, left - 1);
              return;
            }
            const start = source.getLocFromIndex(at + index);
            const end = source.getLocFromIndex(at + index + found.length);
            context.report({ loc: { start, end }, messageId: held ? 'frozen' : 'literal', data: { value: found } });
          };
          for (const h of value.matchAll(HEX)) report(h.index, h[0]);
          for (const f of value.matchAll(FUNC)) report(f.index, f[0].slice(0, -1));
          if (COLOUR_PROPERTY.test(prop)) {
            // url(...) holds no colour keyword
            const plain = value.replace(/url\([^)]*\)/gi, (u) => ' '.repeat(u.length));
            for (const w of plain.matchAll(WORD)) if (NAMED.has(w[0].toLowerCase())) report(w.index, w[0]);
          }
        }
      },
    };
  },
};

export default {
  meta: { name: 'medlevo-css' },
  languages: { css: cssText },
  rules: { 'token-colors': tokenColors },
};
