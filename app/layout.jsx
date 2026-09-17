import "./globals.css";
import MobileTabBar from "@/components/MobileTabBar";
import SiteFooter from "@/components/SiteFooter";
import OfflineScreen from "@/components/OfflineScreen";

export const metadata = {
  title: "chatmarket — AI workers for real business work",
  description:
    "Discover Playbooks, Workflows, and Agents that do specific jobs — reusable AI knowledge, repeatable automations, and AI workers you can delegate to.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <SiteFooter />
        <MobileTabBar />
        <OfflineScreen />
      </body>
    </html>
  );
}
