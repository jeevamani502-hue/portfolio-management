/**
 * Terminal-style design tokens.
 *
 * Colour semantics deserve a note: this platform uses green for up and red for
 * down, the convention on NSE/BSE terminals and every major Indian broker.
 * (US-style red-up/green-down would confuse an Indian audience.) Both hues are
 * chosen to stay distinguishable under the common forms of colour-vision
 * deficiency, and direction is never signalled by colour alone — every
 * change value carries an explicit + or − sign and an arrow glyph.
 */
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // Market direction
        up: 'hsl(var(--up))',
        'up-muted': 'hsl(var(--up-muted))',
        down: 'hsl(var(--down))',
        'down-muted': 'hsl(var(--down-muted))',
        flat: 'hsl(var(--flat))',
        // Data-status chips
        live: 'hsl(var(--live))',
        delayed: 'hsl(var(--delayed))',
        stale: 'hsl(var(--stale))',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      keyframes: {
        'flash-up': {
          '0%': { backgroundColor: 'hsl(var(--up) / 0.25)' },
          '100%': { backgroundColor: 'transparent' },
        },
        'flash-down': {
          '0%': { backgroundColor: 'hsl(var(--down) / 0.25)' },
          '100%': { backgroundColor: 'transparent' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
      },
      animation: {
        'flash-up': 'flash-up 600ms ease-out',
        'flash-down': 'flash-down 600ms ease-out',
        'pulse-dot': 'pulse-dot 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
