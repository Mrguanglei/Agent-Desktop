/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          0: '#ffffff',
          1: '#f7f7f8',
          2: '#efeff2',
          3: '#e7e7eb',
          border: '#e4e4e8'
        },
        accent: {
          DEFAULT: '#4f8cff',
          soft: '#e8efff'
        }
      },
      fontFamily: {
        mono: ['"SF Mono"', 'Menlo', 'Monaco', 'Consolas', 'monospace']
      }
    }
  },
  plugins: []
}
