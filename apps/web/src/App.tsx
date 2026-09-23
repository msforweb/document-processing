import { ChangeEvent, FormEvent, useEffect, useState } from 'react';
import { FileText, LayoutDashboard, Settings, ShieldCheck, UploadCloud } from 'lucide-react';

type DocumentRecord = {
  id: string;
  filename: string;
  documentType: string;
  status: string;
  size: number;
  createdAt: string;
  vendorName?: string | null;
  invoiceNumber?: string | null;
  totalAmount?: number | null;
  currency?: string | null;
  dueDate?: string | null;
  summary?: string;
  validationFlags?: string[];
  riskScore?: number;
};

const metrics = [
  { label: 'Documents today', value: '0', detail: 'Ready for your first upload' },
  { label: 'Auto-approval rate', value: '--', detail: 'Awaiting processing data' },
  { label: 'Needs review', value: '0', detail: 'No outstanding work' },
];

function App(): JSX.Element {
  const [email, setEmail] = useState('admin@example.com');
  const [password, setPassword] = useState('demo-password');
  const [token, setToken] = useState<string>(() => localStorage.getItem('ledgerflow-token') ?? '');
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loginError, setLoginError] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('Summarize the risk flags for a vendor invoice with a missing tax ID.');
  const [reply, setReply] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [selectedDocumentDetails, setSelectedDocumentDetails] = useState<DocumentRecord | null>(null);
  const [selectedDocumentSummary, setSelectedDocumentSummary] = useState('');

  const getPriorityScore = (doc: DocumentRecord): number => {
    let riskScore = 0;

    if (!doc.vendorName || !doc.vendorName.trim()) riskScore += 30;
    if (!doc.invoiceNumber || !doc.invoiceNumber.trim() || doc.invoiceNumber === 'N/A') riskScore += 30;
    if (!doc.totalAmount || Number(doc.totalAmount) <= 0) riskScore += 25;
    if (!doc.currency || !doc.currency.trim()) riskScore += 15;
    if (doc.status === 'REVIEW_REQUIRED') riskScore += 20;

    return riskScore;
  };

  const reviewQueue = documents
    .filter((doc) => ['PROCESSING', 'EXTRACTED', 'VALIDATING', 'REVIEW_REQUIRED'].includes(doc.status))
    .map((doc) => ({ ...doc, riskScore: getPriorityScore(doc) }))
    .sort((left, right) => right.riskScore - left.riskScore);
  const reviewCount = reviewQueue.length;
  const metrics = [
    {
      label: 'Documents today',
      value: String(documents.length),
      detail: documents.length ? 'Across active intake' : 'Ready for your first upload',
    },
    {
      label: 'Auto-approval rate',
      value: documents.length ? `${Math.max(0, 100 - reviewCount * 25)}%` : '--',
      detail: documents.length ? 'Based on current queue' : 'Awaiting processing data',
    },
    {
      label: 'Needs review',
      value: String(reviewCount),
      detail: reviewCount ? 'Awaiting review' : 'No outstanding work',
    },
  ];

  useEffect(() => {
    if (!token) {
      return;
    }

    void loadDocuments();
  }, [token]);

  async function loadDocuments(): Promise<void> {
    if (!token) {
      return;
    }

    const response = await fetch('http://localhost:3001/api/documents', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      setStatus('Session expired. Please log in again.');
      setToken('');
      localStorage.removeItem('ledgerflow-token');
      return;
    }

    const data = (await response.json()) as DocumentRecord[];
    setDocuments(data);
    setStatus(data.length ? `Loaded ${data.length} uploaded document(s).` : 'No documents uploaded yet.');
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoginError('');
    setStatus('Signing in...');

    try {
      const response = await fetch('http://localhost:3001/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = (await response.json()) as { accessToken?: string; message?: string };

      if (!response.ok || !data.accessToken) {
        throw new Error(data.message || 'Unable to login.');
      }

      setToken(data.accessToken);
      localStorage.setItem('ledgerflow-token', data.accessToken);
      setStatus('Signed in successfully.');
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Login failed.';
      setLoginError(messageText);
      setStatus('');
    }
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const selectedFiles = Array.from(event.target.files ?? []);
    if (!selectedFiles.length || !token) {
      return;
    }

    setUploading(true);
    setStatus('Uploading files...');

    try {
      const formData = new FormData();
      selectedFiles.forEach((file) => formData.append('files', file));

      const response = await fetch('http://localhost:3001/api/documents/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.message || 'Upload failed.');
      }

      const uploadedCount = Array.isArray(data) ? data.length : 1;
      setStatus(`Uploaded ${uploadedCount} document(s) successfully.`);
      event.target.value = '';
      await loadDocuments();
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Upload failed.';
      setStatus(messageText);
    } finally {
      setUploading(false);
    }
  }

  async function loadDocumentSummary(documentId: string): Promise<void> {
    if (!token) {
      return;
    }

    const response = await fetch(`http://localhost:3001/api/documents/${documentId}/summary`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      return;
    }

    const data = (await response.json()) as DocumentRecord & { summary?: string };
    setSelectedDocumentDetails(data);
    setSelectedDocumentSummary(data.summary || 'No summary available.');
  }

  async function handleAiSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!message.trim()) {
      return;
    }

    setAiLoading(true);
    setReply('');

    try {
      const response = await fetch('http://localhost:3001/api/ai/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message }),
      });

      const data = (await response.json()) as { reply?: string; message?: string };
      if (!response.ok) {
        throw new Error(data.message || 'Unable to reach the AI assistant.');
      }

      setReply(data.reply || 'No response returned.');
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Unexpected error.';
      setReply(messageText);
    } finally {
      setAiLoading(false);
    }
  }

  async function handleProcessDocument(documentId: string): Promise<void> {
    if (!token) {
      return;
    }

    setStatus('Processing document...');

    try {
      const response = await fetch(`http://localhost:3001/api/documents/${documentId}/process`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = (await response.json()) as { message?: string; status?: string };
      if (!response.ok) {
        throw new Error(data.message || 'Unable to process this document.');
      }

      setStatus(`Document moved to ${data.status || 'processing'} status.`);
      await loadDocuments();
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Processing failed.';
      setStatus(messageText);
    }
  }

  async function handleReviewDocument(documentId: string, decision: 'APPROVED' | 'REJECTED' | 'REVIEW_REQUIRED'): Promise<void> {
    if (!token) {
      return;
    }

    setStatus(`Submitting ${decision.toLowerCase()} decision...`);

    try {
      const response = await fetch(`http://localhost:3001/api/documents/${documentId}/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ decision }),
      });

      const data = (await response.json()) as { message?: string; status?: string };
      if (!response.ok) {
        throw new Error(data.message || 'Unable to complete review.');
      }

      setStatus(`Document marked as ${data.status || decision}.`);
      await loadDocuments();
      if (selectedDocumentId === documentId) {
        await loadDocumentSummary(documentId);
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Review failed.';
      setStatus(messageText);
    }
  }

  useEffect(() => {
    if (!selectedDocumentId) {
      setSelectedDocumentDetails(null);
      setSelectedDocumentSummary('');
      return;
    }

    void loadDocumentSummary(selectedDocumentId);
  }, [selectedDocumentId, token]);

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
        <header className="topbar">
          <div><p className="eyebrow">OPERATIONS CONSOLE</p><h1>Good morning, team.</h1></div>
          <div className="user-chip"><span className="status-dot" />{token ? 'Authenticated' : 'Demo workspace'}</div>
        </header>

        <section className="hero-row">
          <div>
            <p className="eyebrow accent">DOCUMENT AUTOMATION</p>
            <h2>Turn incoming paperwork<br />into trusted data.</h2>
            <p className="hero-copy">Upload financial documents and let LedgerFlow classify, extract, validate, and route them for review.</p>
          </div>
          <label className="upload-button" htmlFor="document-upload" aria-label="Upload documents">
            <UploadCloud size={18} />{uploading ? 'Uploading...' : 'Upload documents'}
          </label>
          <input id="document-upload" type="file" accept="application/pdf,image/png,image/jpeg" multiple onChange={handleUpload} hidden />
        </section>

        <section className="metric-grid" aria-label="Processing metrics">
          {metrics.map((metric) => (
            <article className="metric-card" key={metric.label}>
              <p>{metric.label}</p>
              <strong>{metric.value}</strong>
              <span>{metric.detail}</span>
            </article>
          ))}
        </section>

        <section className="panel-grid">
          <div className="panel-box auth-panel">
            <div className="panel-header">
              <p className="eyebrow accent">ACCESS</p>
              <h3>{token ? 'Authenticated session' : 'Sign in to manage documents'}</h3>
            </div>

            {!token ? (
              <form onSubmit={handleLogin} className="auth-form">
                <label>
                  <span>Email</span>
                  <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
                </label>
                <label>
                  <span>Password</span>
                  <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
                </label>
                <button type="submit" className="secondary-button">Login</button>
                {loginError ? <p className="error-text">{loginError}</p> : null}
              </form>
            ) : (
              <div className="auth-status">
                <p>Signed in with demo admin account.</p>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setToken('');
                    localStorage.removeItem('ledgerflow-token');
                    setDocuments([]);
                    setStatus('Signed out.');
                  }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>

          <div className="panel-box docs-panel">
            <div className="panel-header">
              <p className="eyebrow accent">DOCUMENTS</p>
              <h3>Recent uploads</h3>
            </div>

            {documents.length ? (
              <ul className="document-list">
                {documents.map((doc) => (
                  <li key={doc.id}>
                    <div>
                      <strong>{doc.filename}</strong>
                      <span>{doc.documentType}</span>
                    </div>
                    <div className="document-meta">
                      <small>{doc.status}</small>
                      <small>{Math.round(doc.size / 1024)} KB</small>
                    </div>
                    {doc.status === 'UPLOADED' ? (
                      <button type="button" className="secondary-button compact-button" onClick={() => void handleProcessDocument(doc.id)}>
                        Process
                      </button>
                    ) : null}
                    {doc.status !== 'UPLOADED' && doc.status !== 'APPROVED' && doc.status !== 'REJECTED' ? (
                      <div className="review-actions">
                        <button type="button" className="secondary-button compact-button" onClick={() => void handleReviewDocument(doc.id, 'APPROVED')}>
                          Approve
                        </button>
                        <button type="button" className="secondary-button compact-button danger-button" onClick={() => void handleReviewDocument(doc.id, 'REJECTED')}>
                          Reject
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-state">
                <p>No documents uploaded yet.</p>
              </div>
            )}
          </div>
        </section>

        <section className="panel-box review-panel" aria-label="Review queue">
          <div className="panel-header">
            <p className="eyebrow accent">REVIEW QUEUE</p>
            <h3>Pending actions</h3>
          </div>

          {reviewQueue.length ? (
            <ul className="document-list review-list">
              {reviewQueue.map((doc) => (
                <li key={doc.id} onClick={() => setSelectedDocumentId(doc.id)} style={{ cursor: 'pointer' }}>
                  <div>
                    <strong>{doc.filename}</strong>
                    <span>{doc.documentType}</span>
                  </div>
                  <div className="document-meta">
                    <small>{doc.status}</small>
                    <small>{doc.riskScore >= 60 ? 'High risk' : doc.riskScore >= 30 ? 'Medium risk' : 'Low risk'}</small>
                    <small>{Math.round(doc.size / 1024)} KB</small>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-state">
              <p>No documents are waiting for review.</p>
            </div>
          )}
        </section>

        <section className="panel-box details-panel" aria-label="Selected document details">
          <div className="panel-header">
            <p className="eyebrow accent">DETAILS</p>
            <h3>{selectedDocumentDetails ? selectedDocumentDetails.filename : 'Select a document'}</h3>
          </div>

          {selectedDocumentDetails ? (
            <div className="detail-grid">
              <div>
                <span className="meta-label">Status</span>
                <strong>{selectedDocumentDetails.status}</strong>
              </div>
              <div>
                <span className="meta-label">Type</span>
                <strong>{selectedDocumentDetails.documentType}</strong>
              </div>
              <div>
                <span className="meta-label">Vendor</span>
                <strong>{selectedDocumentDetails.vendorName ?? 'Not extracted'}</strong>
              </div>
              <div>
                <span className="meta-label">Invoice #</span>
                <strong>{selectedDocumentDetails.invoiceNumber ?? 'Not extracted'}</strong>
              </div>
              <div>
                <span className="meta-label">Amount</span>
                <strong>{selectedDocumentDetails.totalAmount ? `${selectedDocumentDetails.totalAmount.toFixed(2)} ${selectedDocumentDetails.currency ?? 'USD'}` : 'Not extracted'}</strong>
              </div>
              <div>
                <span className="meta-label">Due</span>
                <strong>{selectedDocumentDetails.dueDate ? new Date(selectedDocumentDetails.dueDate).toLocaleDateString() : 'Not extracted'}</strong>
              </div>
              <div>
                <span className="meta-label">Size</span>
                <strong>{Math.round(selectedDocumentDetails.size / 1024)} KB</strong>
              </div>
              <div>
                <span className="meta-label">Uploaded</span>
                <strong>{new Date(selectedDocumentDetails.createdAt).toLocaleDateString()}</strong>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <p>Select a document from the review queue to inspect the details.</p>
            </div>
          )}

          {selectedDocumentSummary ? <p className="detail-summary">{selectedDocumentSummary}</p> : null}

          {selectedDocumentDetails?.validationFlags?.length ? (
            <div style={{ marginTop: '18px' }}>
              <span className="meta-label">Validation flags</span>
              <ul style={{ margin: '8px 0 0', paddingLeft: '18px', color: '#fbbf24' }}>
                {selectedDocumentDetails.validationFlags.map((flag) => (
                  <li key={flag}>{flag}</li>
                ))}
              </ul>
              {selectedDocumentDetails.riskScore !== undefined ? (
                <p style={{ marginTop: '8px', color: '#fbbf24' }}>
                  Risk score: {selectedDocumentDetails.riskScore}/100
                </p>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="ai-panel" aria-label="AI assistant">
          <div className="ai-panel-header">
            <div>
              <p className="eyebrow accent">AI ASSISTANT</p>
              <h3>Ask about a document or workflow</h3>
            </div>
          </div>

          <form onSubmit={handleAiSubmit} className="ai-form">
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={4}
              placeholder="Ask the AI assistant about a document, a risk exception, or a workflow question..."
            />
            <div className="ai-actions">
              <button type="submit" className="secondary-button" disabled={aiLoading}>
                {aiLoading ? 'Thinking...' : 'Ask AI'}
              </button>
            </div>
          </form>

          {reply ? (
            <div className="ai-response">
              <strong>Assistant reply</strong>
              <p>{reply}</p>
            </div>
          ) : null}
        </section>

        {status ? <div className="status-banner">{status}</div> : null}
      </main>
    </div>
  );
}

export default App;
