// lib/domain/paise.js -- money is integer paise everywhere; only the final display string is formatted.
// integer paise -> "₹1,234.50" (never floats through the arithmetic; only the final string is formatted)
export function formatPaise(paise) {
  if (!Number.isInteger(paise)) return "—";
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}₹${rupees}.${String(abs % 100).padStart(2, "0")}`;
}

