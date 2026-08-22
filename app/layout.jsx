import "./globals.css";
import MobileTabBar from "@/components/MobileTabBar";

export const metadata = {
  title: "chatmarket — continue where they left off",
  description: "Buy and sell working AI chat threads from Claude, ChatGPT, and Gemini.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <MobileTabBar />
      </body>
    </html>
  );
}
