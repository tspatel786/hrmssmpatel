/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['"Space Grotesk"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        // S.M.PATEL IT HUB gold (#D4AF37 = 500). 700+ keep >= 4.5:1 contrast as text on white.
        brand: {
          50: '#fdf9ec', 100: '#faf0cc', 200: '#f5e09a', 300: '#f0cd62', 400: '#e6bc45',
          500: '#d4af37', 600: '#b8932a', 700: '#85661a', 800: '#6b5216', 900: '#574313', 950: '#34270a',
        },
        // website surfaces
        ink: { DEFAULT: '#050505', 900: '#0a0a0a', 800: '#111111', 700: '#1a1a1a', 600: '#262626', muted: '#a8a8a8' },
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(16 24 40 / 0.04), 0 1px 3px 0 rgb(16 24 40 / 0.06)',
        pop: '0 12px 32px -8px rgb(16 24 40 / 0.18), 0 4px 8px -4px rgb(16 24 40 / 0.06)',
      },
    },
  },
  plugins: [],
};
