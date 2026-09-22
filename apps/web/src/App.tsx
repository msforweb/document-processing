import { FileText, LayoutDashboard, Settings, ShieldCheck, UploadCloud } from 'lucide-react';

const metrics = [
  { label: 'Documents today', value: '0', detail: 'Ready for your first upload' },
  { label: 'Auto-approval rate', value: '--', detail: 'Awaiting processing data' },
  { label: 'Needs review', value: '0', detail: 'No outstanding work' },
];

function App(): JSX.Element {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">L</span><span>LedgerFlow</span></div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="nav-list" aria-label="Main navigation">
          <a className="nav-item active" href="#dashboard"><LayoutDashboard size={18} />Overview</a>
          <a className="nav-item" href="#documents"><FileText size={18} />Documents</a>
          <a className="nav-item" href="#review"><ShieldCheck size={18} />Review queue <span className="nav-count">0</span></a>
        </nav>
        <div className="sidebar-bottom"><a className="nav-item" href="#settings"><Settings size={18} />Settings</a></div>
      </aside>
      <main className="main-content">
        <header className="topbar"><div><p className="eyebrow">OPERATIONS CONSOLE</p><h1>Good morning, team.</h1></div><div className="user-chip"><span className="status-dot" />Demo workspace</div></header>
        <section className="hero-row">
          <div><p className="eyebrow accent">DOCUMENT AUTOMATION</p><h2>Turn incoming paperwork<br />into trusted data.</h2><p className="hero-copy">Upload financial documents and let LedgerFlow classify, extract, validate, and route them for review.</p></div>
          <button className="upload-button"><UploadCloud size={18} />Upload documents</button>
        </section>
        <section className="metric-grid" aria-label="Processing metrics">{metrics.map((metric) => <article className="metric-card" key={metric.label}><p>{metric.label}</p><strong>{metric.value}</strong><span>{metric.detail}</span></article>)}</section>
        <section className="empty-panel"><div className="empty-icon"><FileText size={24} /></div><h3>Your processing workspace is ready</h3><p>Upload an invoice, bank statement, KYC form, or compliance report to begin.</p><button className="secondary-button">Browse files</button></section>
      </main>
    </div>
  );
}

export default App;
