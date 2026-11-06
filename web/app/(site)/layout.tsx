import { currentAccount } from "@/lib/session";
import { Logo } from "@/components/ui";

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const signedIn = !!(await currentAccount());
  return (
    <>
      <header className="site-header">
        <div className="container">
          <Logo />
          <nav className="nav" aria-label="Main">
            <a className="link hide-sm" href="/#features">Features</a>
            <a className="link hide-sm" href="/pricing">Pricing</a>
            <a className="link hide-sm" href="/openapi.json">API</a>
            {signedIn ? (
              <a className="btn sm" href="/console">Open console</a>
            ) : (
              <>
                <a className="link" href="/login">Sign in</a>
                <a className="btn sm" href="/signup">Start free</a>
              </>
            )}
          </nav>
        </div>
      </header>
      <main>{children}</main>
      <footer className="site-footer">
        <div className="container">
          <div><Logo /><p className="small" style={{ marginTop: 8, maxWidth: 360 }}>Non-custodial USDT payments on Whitechain. WhitePay never holds your funds.</p></div>
          <div className="small">
            <div><a href="/pricing">Pricing</a></div>
            <div><a href="/openapi.json">API reference (OpenAPI)</a></div>
            <div><a href="/index.html">Demo store</a></div>
            <div><a href="/login">Sign in</a></div>
          </div>
        </div>
      </footer>
    </>
  );
}
