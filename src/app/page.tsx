import Link from "next/link";
import { Check, Cloud, LockKeyhole, LogOut, ArrowRight } from "lucide-react";
import { getChatGPTUser, chatGPTSignInPath, chatGPTSignOutPath } from "./chatgpt-auth";
import AppleConnection from "./apple-connection";
export const dynamic = "force-dynamic";
export default async function Home() {
  const user = await getChatGPTUser();
  const signOutPath = user?.authProvider === "cloudflare-access" ? "/cdn-cgi/access/logout" : chatGPTSignOutPath();
  return <main className="app-shell">
    <header className="app-header">
      <Link className="brand" href="/" aria-label="iCloud Reminders home"><span className="brand-icon"><Check size={23} aria-hidden="true" /></span><span className="brand-name">iCloud Reminders</span></Link>
      <div className="header-actions"><span className="private-badge"><LockKeyhole size={14} aria-hidden="true" /> Private workspace</span>{user && <><span className="user-label">{user.fullName?.split(" ")[0] || user.email}</span><a className="logout-link" href={signOutPath} target="_top"><LogOut size={16} aria-hidden="true" /> Sign out</a></>}</div>
    </header>
    {user ? <><div className="page-heading"><div><h1>Reminders connection</h1><p>Connect your account, find your lists, and check your reminders.</p></div></div><AppleConnection /></> : <div className="login-layout"><section className="login-card" aria-labelledby="login-title">
      <div className="login-icon"><Cloud size={34} aria-hidden="true" /></div><h1 id="login-title">Your reminders,<br />ready for ChatGPT.</h1><p>Connect iCloud Reminders to your private workspace and ask ChatGPT what needs doing.</p>
      <a className="signin-button" href={chatGPTSignInPath("/")} target="_top">Sign in with ChatGPT <ArrowRight size={19} aria-hidden="true" /></a>
      <ol className="login-steps"><li><span className="login-step-number">1</span>Sign in to your workspace</li><li><span className="login-step-number">2</span>Connect your Apple account</li><li><span className="login-step-number">3</span>Find your lists and preview reminders</li></ol>
      <p className="login-note"><LockKeyhole size={15} aria-hidden="true" /> Private access to your reminders.</p>
    </section></div>}
    <footer className="app-footer"><span>iCloud Reminders</span><span>Unofficial integration</span></footer>
  </main>;
}
