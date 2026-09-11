import { Linkedin, Facebook, Instagram, Youtube } from "lucide-react";

// Placeholder hrefs ("#") for LinkedIn/Facebook/Instagram/YouTube until the
// actual social pages exist — swap these in as soon as they're live. The
// WhatsApp number is real and already wired up (wa.me links work with just
// a phone number, no separate "page" needed).
const WHATSAPP_NUMBER = "919150427083"; // +91 9150427083, no leading zeros/symbols for the wa.me link
const WHATSAPP_DISPLAY = "+91 9150427083";

const SOCIAL_LINKS = [
  { label: "LinkedIn", href: "#", Icon: Linkedin },
  { label: "Facebook", href: "#", Icon: Facebook },
  { label: "Instagram", href: "#", Icon: Instagram },
  { label: "YouTube", href: "#", Icon: Youtube },
];

function WhatsAppIcon({ size = 16 }) {
  // No WhatsApp glyph ships in lucide-react, and using the brand's own
  // green would break from the rest of this row — this is the standard
  // WhatsApp mark redrawn as a plain currentColor outline so it matches
  // the other (monochrome) icons here exactly.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.86 9.86 0 0 0 12.04 2Zm0 1.67c2.19 0 4.25.85 5.79 2.4a8.16 8.16 0 0 1 2.4 5.79c0 4.52-3.68 8.2-8.2 8.2a8.2 8.2 0 0 1-4.17-1.14l-.3-.18-3.12.82.83-3.04-.19-.31a8.18 8.18 0 0 1-1.26-4.37c0-4.52 3.68-8.17 8.22-8.17Zm-4.52 4.3c-.15 0-.4.06-.61.3-.21.24-.8.78-.8 1.9 0 1.12.82 2.2.93 2.36.12.15 1.6 2.53 3.97 3.49 1.96.8 2.36.64 2.79.6.42-.04 1.36-.55 1.55-1.09.19-.53.19-.98.13-1.08-.06-.09-.21-.15-.44-.27-.23-.12-1.36-.67-1.57-.75-.21-.08-.36-.12-.52.12-.15.23-.6.75-.73.9-.13.15-.27.17-.5.06-.23-.12-.98-.36-1.86-1.15-.69-.61-1.15-1.37-1.29-1.6-.13-.23-.01-.36.1-.47.11-.11.23-.27.35-.4.11-.14.15-.23.23-.39.08-.15.04-.29-.02-.4-.06-.12-.52-1.26-.72-1.72-.19-.45-.38-.4-.52-.4Z" />
    </svg>
  );
}

export default function SocialBar() {
  return (
    <div className="hidden sm:flex items-center gap-4">
      {SOCIAL_LINKS.map(({ label, href, Icon }) => (
        <a
          key={label}
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-label={label}
          style={{ color: "#6B6F76" }}
          className="hover:opacity-70 transition-opacity"
        >
          <Icon size={16} strokeWidth={1.75} />
        </a>
      ))}
      <a
        href={`https://wa.me/${WHATSAPP_NUMBER}`}
        target="_blank"
        rel="noreferrer"
        aria-label="WhatsApp"
        style={{ color: "#6B6F76" }}
        className="flex items-center gap-1.5 hover:opacity-70 transition-opacity"
      >
        <WhatsAppIcon />
        <span className="text-xs" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{WHATSAPP_DISPLAY}</span>
      </a>
    </div>
  );
}
