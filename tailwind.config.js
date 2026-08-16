/* The neutral ramp is CSS VARIABLES, which is what makes dark mode a
   theme-layer change rather than a rewrite of 557 call sites.
   `text-stone-500` means "muted text" in both modes; only the value
   behind it moves. Channel triples (not hex) so Tailwind's opacity
   modifiers -- bg-white/95, bg-stone-50/90 -- keep working.
   
   `white` is deliberately NOT flipped: text-white sits on accent
   buttons, where it is correct in both modes. Surfaces that used to
   say bg-white now say bg-surface, which does flip; and bg-paper is
   the opt-out for note paper, which stays light in v1 so handwriting
   stays readable without touching a single stored stroke colour. */
const tone = (v) => `rgb(var(${v}) / <alpha-value>)`;

module.exports = {
  content: ["./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        stone: {
          50: tone("--tone-50"),
          100: tone("--tone-100"),
          200: tone("--tone-200"),
          300: tone("--tone-300"),
          400: tone("--tone-400"),
          500: tone("--tone-500"),
          600: tone("--tone-600"),
          700: tone("--tone-700"),
          800: tone("--tone-800"),
          900: tone("--tone-900"),
        },
        surface: tone("--surface"),
        paper: tone("--paper"),
      },
    },
  },
  plugins: [],
};
