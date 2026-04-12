import { useState } from 'react';
import type { LinkedDocument } from '../types';

/** Renders source document buttons + a full-screen modal viewer */
export function DocumentViewer({ documents }: { documents?: LinkedDocument[] }) {
  const [viewingDoc, setViewingDoc] = useState<string | null>(null);

  return (
    <>
      {documents && documents.length > 0 ? (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #e9ecef' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#495057', marginBottom: 6 }}>
            Source Documents
          </div>
          {documents.map((doc) => (
            <button
              key={doc.id}
              className="btn btn-ghost btn-sm"
              style={{ marginRight: 8, fontSize: 12 }}
              onClick={(e) => { e.stopPropagation(); setViewingDoc(doc.id); }}
            >
              📄 {doc.filename}
              {doc.file_size ? ` (${(doc.file_size / 1024).toFixed(0)} KB)` : ''}
            </button>
          ))}
        </div>
      ) : (
        <div style={{ marginTop: 10, fontSize: 12, color: '#adb5bd', fontStyle: 'italic' }}>
          No source document attached
        </div>
      )}

      {viewingDoc && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setViewingDoc(null)}
        >
          <div
            style={{
              backgroundColor: '#fff', borderRadius: 8, width: '85vw', height: '85vh',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
              boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{
              padding: '12px 16px', borderBottom: '1px solid #e9ecef',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Source Document</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setViewingDoc(null)}>
                ✕ Close
              </button>
            </div>
            <iframe
              src={`/api/documents/${viewingDoc}/file`}
              style={{ flex: 1, border: 'none', width: '100%' }}
              title="Source document"
            />
          </div>
        </div>
      )}
    </>
  );
}
