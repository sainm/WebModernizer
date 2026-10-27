/**
 * Vendor-prefix mapping used both for advice and for automation.
 *
 * The distinction matters: copying a value from a `-ms-` property to the standard one
 * is only safe when the two properties accept the same value syntax. `-ms-flex: 1`
 * and `flex: 1` do not mean the same thing, and `-ms-writing-mode: lr-tb` has no
 * direct `writing-mode` equivalent — rewriting those would produce code that looks
 * migrated and renders differently.
 */
export const IDENTICAL_SYNTAX: Record<string, string> = {
  '-ms-transform': 'transform',
  '-ms-transform-origin': 'transform-origin',
  '-ms-transition': 'transition',
  '-ms-transition-property': 'transition-property',
  '-ms-transition-duration': 'transition-duration',
  '-ms-transition-timing-function': 'transition-timing-function',
  '-ms-transition-delay': 'transition-delay',
  '-ms-animation': 'animation',
  '-ms-animation-name': 'animation-name',
  '-ms-animation-duration': 'animation-duration',
  '-ms-animation-delay': 'animation-delay',
  '-ms-animation-iteration-count': 'animation-iteration-count',
  '-ms-user-select': 'user-select',
  '-ms-box-sizing': 'box-sizing',
  '-ms-box-shadow': 'box-shadow',
  '-ms-border-radius': 'border-radius',
  '-ms-zoom': 'zoom',
};

/** Properties that look similar but whose value syntax or semantics differ. */
export const DIFFERENT_SYNTAX: Record<string, string> = {
  '-ms-flex': 'flex',
  '-ms-flex-align': 'align-items',
  '-ms-flex-pack': 'justify-content',
  '-ms-flex-order': 'order',
  '-ms-flex-positive': 'flex-grow',
  '-ms-flex-negative': 'flex-shrink',
  '-ms-flex-preferred-size': 'flex-basis',
  '-ms-flex-direction': 'flex-direction',
  '-ms-flex-wrap': 'flex-wrap',
  '-ms-writing-mode': 'writing-mode',
  '-ms-touch-action': 'touch-action',
  '-ms-ime-mode': '(no equivalent)',
};

export function standardForMs(property: string): string | null {
  return IDENTICAL_SYNTAX[property.toLowerCase()] ?? null;
}

export function similarStandardForMs(property: string): string | null {
  return DIFFERENT_SYNTAX[property.toLowerCase()] ?? null;
}
