import React, { useEffect, useState } from 'react';
import { fileImage } from './client.js';

export const imagePath = path => /\.(png|jpe?g|gif|webp)$/i.test(path);

export function ImagePane({ rootId, path, name }) {
  const [revision, refresh] = useState(0);
  const [fit, setFit] = useState(true);
  const [source, setSource] = useState(null);
  const [size, setSize] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let url;
    const controller = new AbortController();
    setSource(null); setSize(null); setError('');
    fileImage(rootId, path, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob); setSource(url);
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [rootId, path, revision]);
  return <div className="image-preview pane" data-root={rootId} data-path={path}>
    <div className="pane-tools"><span title={`${name} / ${path}`}>{name} / {path}</span>
      {size && <span className="muted">{size.width} × {size.height}</span>}
      <button onClick={() => setFit(!fit)}>{fit ? 'Actual size' : 'Fit image'}</button>
      <button aria-label="Refresh image" onClick={() => refresh(value => value + 1)}>Refresh</button></div>
    {error ? <div className="error" role="alert">{error}</div> : <div className={`image-stage ${fit ? 'fit' : 'actual'}`}>
      {source ? <img src={source} alt={`${name} / ${path}`} onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={() => setError('The browser cannot decode this image. Refresh after repairing or replacing the file.')} /> : <p className="muted">Loading image…</p>}
    </div>}
  </div>;
}
