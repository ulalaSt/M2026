import { useState } from 'react';
import type { DraftPosition, Schema } from '../types';

type Props = {
  schema: Schema;
  onAdd: (pos: DraftPosition) => void;
  onClose: () => void;
};

export function PositionModal({ schema, onAdd, onClose }: Props) {
  const [color, setColor] = useState<string>('');
  const [size, setSize] = useState<string>('');
  const [kind, setKind] = useState<string>('');
  const [qtyStr, setQtyStr] = useState<string>('1');

  const qty = parseInt(qtyStr, 10);
  const ready = !!(color && size && kind && Number.isFinite(qty) && qty > 0);

  function submit() {
    if (!ready) return;
    onAdd({ color, size, kind, qty });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
         onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-md bg-tg-bg rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[92vh] overflow-y-auto">
        {/* Drag handle */}
        <div className="sm:hidden flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-tg-hint/40" />
        </div>

        <div className="p-5 pt-2 sm:pt-5 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold">Новая позиция</h2>
            <button onClick={onClose}
              className="w-9 h-9 rounded-full bg-tg-secondary-bg text-xl flex items-center justify-center active:scale-90 transition-transform">×</button>
          </div>

          <Section title="Цвет" required={!color}>
            <div className="flex flex-wrap gap-2">
              {schema.colors.map(c => {
                const emoji = c.split(/\s/)[0];
                const name = c.split(/\s/).slice(1).join(' ') || c;
                const active = color === c;
                return (
                  <button key={c} onClick={() => setColor(c)}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-full text-sm font-medium transition-all ${active
                      ? 'bg-tg-button text-tg-button-text shadow-sm'
                      : 'bg-tg-secondary-bg text-tg-text active:scale-95'}`}>
                    <span className="text-base">{emoji}</span>
                    <span>{name}</span>
                  </button>
                );
              })}
            </div>
          </Section>

          <Section title="Размер" required={!size}>
            <div className="grid grid-cols-3 gap-2">
              {schema.sizes.map(s => {
                const active = size === s;
                return (
                  <button key={s} onClick={() => setSize(s)}
                    className={`py-3 rounded-xl text-base font-semibold transition-all ${active
                      ? 'bg-tg-button text-tg-button-text shadow-sm'
                      : 'bg-tg-secondary-bg text-tg-text active:scale-95'}`}>
                    {s}
                  </button>
                );
              })}
            </div>
          </Section>

          <Section title="Вид" required={!kind}>
            <div className="grid grid-cols-3 gap-2">
              {schema.kinds.map(k => {
                const active = kind === k;
                return (
                  <button key={k} onClick={() => setKind(k)}
                    className={`py-2.5 rounded-xl text-sm font-medium transition-all ${active
                      ? 'bg-tg-button text-tg-button-text shadow-sm'
                      : 'bg-tg-secondary-bg text-tg-text active:scale-95'}`}>
                    {k}
                  </button>
                );
              })}
            </div>
          </Section>

          <Section title="Количество">
            <div className="flex items-center justify-center gap-3">
              <button onClick={() => setQtyStr(String(Math.max(1, (Number.isFinite(qty) ? qty : 1) - 1)))}
                className="w-12 h-12 rounded-full bg-tg-secondary-bg text-2xl active:scale-90 transition-transform">−</button>
              <input type="number" inputMode="numeric" value={qtyStr}
                onChange={e => setQtyStr(e.target.value)}
                onBlur={() => { if (!Number.isFinite(qty) || qty < 1) setQtyStr('1'); }}
                className="w-24 text-center bg-tg-secondary-bg rounded-xl py-3 text-2xl font-bold outline-none" />
              <button onClick={() => setQtyStr(String((Number.isFinite(qty) ? qty : 0) + 1))}
                className="w-12 h-12 rounded-full bg-tg-secondary-bg text-2xl active:scale-90 transition-transform">+</button>
            </div>
          </Section>

          <button onClick={submit} disabled={!ready}
            className={`w-full py-4 rounded-2xl font-semibold text-base transition-all ${ready
              ? 'bg-tg-button text-tg-button-text shadow-md active:scale-[0.98]'
              : 'bg-tg-secondary-bg text-tg-hint cursor-not-allowed'}`}>
            {ready ? `Добавить (×${qty})` : 'Выбери все поля'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, required, children }: { title: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-sm font-medium text-tg-hint mb-2">
        <span>{title}</span>
        {required && <span className="w-1 h-1 rounded-full bg-tg-destructive" />}
      </div>
      {children}
    </div>
  );
}
