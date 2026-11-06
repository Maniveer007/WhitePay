export default function NotFound() {
  return (
    <div className="auth-page">
      <div className="auth-card" style={{ textAlign: "center" }}>
        <h1>Page not found</h1>
        <p className="mut">That page doesn't exist, or it moved.</p>
        <a className="btn" href="/">Back to home</a>
      </div>
    </div>
  );
}
