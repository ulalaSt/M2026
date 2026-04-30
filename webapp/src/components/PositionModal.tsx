import { useEffect, useState } from 'react';
import type { DraftPosition, Schema } from '../types';
import { colorClass } from '../App';

type Props = {
  schema: Schema;
  onAdd: (pos: DraftPosition) => void;
  onClose: () => void;
};

function stripEmoji(s: string): string {
  return s.replace(/^\S+\s*/, '').trim() || s;
}

export function PositionModal({ schema, onAdd, onClose }: Props) {
  const [color, setColor] = useState<string>('');
  const [size, setSize] = useState<string>('');
  const [kind, setKind] = useState<string>('');
  const [qtyStr, setQtyStr] = useState<string>('1');
  const [open, setOpen] = useState(false);

  // animate-in
  useEffect(() => {
    requestAnimationFrame(() => setOpen(true));
  }, []);

  const qty = parseInt(qtyStr, 10);
  const ready = !!(color && size && kind && Number.isFinite(qty) && qty > 0);

  function close() {
    setOpen(false);
    setTimeout(onClose, 300);
  }

  function submit() {
    if (!ready) return;
    onAdd({ color, size, kind, qty });
  }

  return (
    <div className={`modal-overlay ${open ? 'open' : ''}`} onClick={close}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-handle" />
        <h2 className="modal-title">Новая <em>позиция</em></h2>
        <div className="modal-sub">Выберите параметры товара</div>

        <div className="group">
          <div className="group-label">Цвет</div>
          <div className="chip-row">
            {schema.colors.map(c => (
              <button key={c} className={`chip ${color === c ? 'active' : ''}`}
                onClick={() => setColor(c)}>
                <span className={`swatch-mini ${colorClass(c)}`} />
                {stripEmoji(c)}
              </button>
            ))}
          </div>
        </div>

        <div className="group">
          <div className="group-label">Размер</div>
          <div className="size-row">
            {schema.sizes.map(s => (
              <button key={s} className={`size-btn ${size === s ? 'active' : ''}`}
                onClick={() => setSize(s)}>{s}</button>
            ))}
          </div>
        </div>

        <div className="group">
          <div className="group-label">Категория</div>
          <div className="chip-row">
            {schema.kinds.map(k => (
              <button key={k} className={`chip ${kind === k ? 'active' : ''}`}
                onClick={() => setKind(k)}>{k}</button>
            ))}
          </div>
        </div>

        <div className="group">
          <div className="group-label">Количество</div>
          <div className="qty-row">
            <button className="qty-btn"
              onClick={() => setQtyStr(String(Math.max(1, (Number.isFinite(qty) ? qty : 1) - 1)))}>−</button>
            <input type="number" inputMode="numeric" className="qty-num" value={qtyStr}
              onChange={e => setQtyStr(e.target.value)}
              onBlur={() => { if (!Number.isFinite(qty) || qty < 1) setQtyStr('1'); }} />
            <button className="qty-btn"
              onClick={() => setQtyStr(String((Number.isFinite(qty) ? qty : 0) + 1))}>+</button>
          </div>
        </div>

        <button className="cta" disabled={!ready} onClick={submit} style={{ marginTop: 12 }}>
          <span>{ready ? `Добавить — ${qty} шт` : 'Выберите цвет, размер и вид'}</span>
          {ready && <span className="arrow">→</span>}
        </button>

        <button className="toggle-extra" onClick={close}
          style={{ marginTop: 10, marginBottom: 0, justifyContent: 'center' }}>
          <span>Отмена</span>
        </button>
      </div>
    </div>
  );
}
