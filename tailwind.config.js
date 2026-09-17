/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,jsx}",
    "./components/**/*.{js,jsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "#14213D",
        paper: "#EDEEEA",
        card: "#F7F7F4",
        amber: "#E2A83E",
        "amber-deep": "#C68F2A",
        teal: "#2F6F62",
        rule: "#D8D5C9",
        muted: "#6B6F76",
        // Phase 2 — product-type accents. Playbook/Agent deliberately reuse
        // the existing teal/amber-deep tokens above rather than introducing
        // new colors for them; "workflow" is the one genuinely new color
        // added to the palette this phase.
        playbook: "#2F6F62",
        workflow: "#5B5FA0",
        agent: "#C68F2A",
      },
      fontFamily: {
        serif: ["Fraunces", "serif"],
        sans: ["IBM Plex Sans", "sans-serif"],
        mono: ["IBM Plex Mono", "monospace"],
      },
    },
  },
  plugins: [],
};
