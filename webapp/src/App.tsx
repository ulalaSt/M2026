import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { getWebApp } from './telegram';
import type { DraftClient, DraftPosition, Schema } from './types';
import { PositionModal } from './components/PositionModal';

function todayIso(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function fmtDateRu(iso: string): string {
  const [y, m, d] = iso.split('-');
  const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
}

function defaultPrice(totalQty: number): number {
  if (totalQty >= 15) return 2000;
  if (totalQty >= 10) return 2300;
  if (totalQty >= 5) return 2600;
  return 3000;
}

function normalizePhone(input: string): string | null {
  let digits = input.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) digits = '7' + digits.slice(1);
  if (digits.length !== 11 || !digits.startsWith('7')) return null;
  return `+${digits[0]} ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
}

function formatPhoneInput(input: string): string {
  let digits = input.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) digits = '7' + digits.slice(1);
  if (digits.length === 0) return '';
  if (digits[0] !== '7') digits = '7' + digits;
  digits = digits.slice(0, 11);
  let out = '+7';
  if (digits.length > 1) out += ' ' + digits.slice(1, 4);
  if (digits.length > 4) out += ' ' + digits.slice(4, 7);
  if (digits.length > 7) out += ' ' + digits.slice(7, 11);
  return out;
}

export default function App() {
  const [schema, setSchema] = useState<Schema | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [phone, setPhone] = useState('');
  const [school, setSchool] = useState('');
  const [address, setAddress] = useState('');
  const [date, setDate] = useState(todayIso());
  const [time, setTime] = useState('');
  const [priceStr, setPriceStr] = useState('');
  const [paidStr, setPaidStr] = useState('2000');
  const [discountStr, setDiscountStr] = useState('');
  const [note, setNote] = useState('');
  const [positions, setPositions] = useState<DraftPosition[]>([]);
  const [showPosModal, setShowPosModal] = useState(false);
  const [showExtras, setShowExtras] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    const tg = getWebApp();
    tg?.ready();
    tg?.expand();
    api.getSchema().then(setSchema).catch(e => setLoadError(String(e?.message ?? e)));
  }, []);

  const totalQty = useMemo(() => positions.reduce((s, p) => s + p.qty, 0), [positions]);
  const autoPrice = useMemo(() => totalQty > 0 ? defaultPrice(totalQty) : 0, [totalQty]);
  const price = priceStr === '' ? autoPrice : parseFloat(priceStr) || 0;
  const paid = parseFloat(paidStr) || 0;
  const discount = parseFloat(discountStr) || 0;
  const sum = price * totalQty;
  const remaining = sum - paid - discount;

  const phoneNormalized = useMemo(() => normalizePhone(phone), [phone]);
  const valid = !!phoneNormalized && !!date && positions.length > 0;

  async function submit() {
    if (!valid || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    const draft: DraftClient = {
      phone: phoneNormalized!,
      school: school || undefined,
      address: address || undefined,
      date,
      time: time || undefined,
      price: priceStr === '' ? autoPrice : Number(priceStr),
      paid: paidStr === '' ? undefined : Number(paidStr),
      discount: discountStr === '' ? undefined : Number(discountStr),
      note: note || undefined,
      positions,
    };
    try {
      const res = await api.createClient(draft);
      const tg = getWebApp();
      tg?.HapticFeedback.notificationOccurred('success');
      tg?.showAlert(`Клиент создан\n${res.url}`, () => tg.close());
    } catch (e: any) {
      setSubmitError(String(e?.message ?? e));
      getWebApp()?.HapticFeedback.notificationOccurred('error');
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="bg-tg-section-bg rounded-3xl p-6 max-w-sm shadow-lg">
          <div className="text-4xl mb-3">⚠️</div>
          <div className="text-tg-destructive font-semibold mb-1">Ошибка загрузки</div>
          <div className="text-sm text-tg-hint break-words">{loadError}</div>
        </div>
      </div>
    );
  }
  if (!schema) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-tg-hint animate-pulse">Загрузка…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-32">
      {/* Header */}
      <div className="bg-gradient-to-b from-tg-button/10 to-transparent pt-6 pb-4 px-5">
        <div className="max-w-md mx-auto">
          <h1 className="text-2xl font-bold tracking-tight">Новый клиент</h1>
          <p className="text-sm text-tg-hint mt-0.5">Заполни форму, чтобы создать заказ</p>
        </div>
      </div>

      <div className="max-w-md mx-auto px-4 space-y-3">
        {/* Phone card */}
        <Card>
          <Label icon="📞">Телефон</Label>
          <input type="tel" inputMode="tel" placeholder="+7 777 123 45 67"
            value={phone}
            onChange={e => setPhone(formatPhoneInput(e.target.value))}
            className={`w-full bg-transparent text-lg font-medium outline-none placeholder:text-tg-hint/60 ${phone && !phoneNormalized ? 'text-tg-destructive' : ''}`} />
          {phone && !phoneNormalized && (
            <div className="text-tg-destructive text-xs mt-1">Должно быть 11 цифр</div>
          )}
        </Card>

        {/* Date card */}
        <Card>
          <Label icon="📅">Дата выдачи</Label>
          <div className="flex gap-2 mb-3">
            {[
              { label: 'Сегодня', d: todayIso() },
              { label: 'Завтра', d: todayIso(1) },
              { label: '+3 дня', d: todayIso(3) },
            ].map(b => (
              <Chip key={b.label} active={date === b.d} onClick={() => setDate(b.d)}>{b.label}</Chip>
            ))}
          </div>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="w-full bg-tg-secondary-bg rounded-xl px-3 py-2.5 text-base outline-none" />
          <div className="text-xs text-tg-hint mt-1.5">{fmtDateRu(date)}</div>
        </Card>

        {/* Positions card */}
        <Card>
          <div className="flex items-center justify-between mb-2">
            <Label icon="📦">Позиции</Label>
            {totalQty > 0 && <span className="text-xs text-tg-hint">всего {totalQty} шт</span>}
          </div>
          {positions.length === 0 ? (
            <button onClick={() => setShowPosModal(true)}
              className="w-full py-6 rounded-xl border-2 border-dashed border-tg-hint/30 text-tg-hint hover:border-tg-link hover:text-tg-link transition-colors">
              <div className="text-2xl mb-1">＋</div>
              <div className="text-sm">Добавить первую позицию</div>
            </button>
          ) : (
            <>
              <div className="space-y-2">
                {positions.map((p, i) => (
                  <PositionRow key={i} p={p} onDelete={() => setPositions(positions.filter((_, j) => j !== i))} />
                ))}
              </div>
              <button onClick={() => setShowPosModal(true)}
                className="mt-3 w-full py-2.5 rounded-xl bg-tg-button/10 text-tg-link font-medium text-sm hover:bg-tg-button/20 transition-colors">
                ＋ Ещё позиция
              </button>
            </>
          )}
        </Card>

        {/* Summary card — only when positions exist */}
        {totalQty > 0 && (
          <div className="bg-gradient-to-br from-tg-button to-tg-button/80 text-tg-button-text rounded-2xl p-4 shadow-md">
            <div className="text-xs uppercase tracking-wider opacity-80 mb-1">К оплате</div>
            <div className="text-3xl font-bold">{remaining.toLocaleString('ru')} ₸</div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
              <Stat label="Сумма" value={`${sum.toLocaleString('ru')}`} />
              <Stat label="Оплачено" value={`${paid.toLocaleString('ru')}`} />
              <Stat label="Скидка" value={`${discount.toLocaleString('ru')}`} />
            </div>
          </div>
        )}

        {/* Extras toggle */}
        <button onClick={() => setShowExtras(!showExtras)}
          className="w-full py-3 rounded-2xl bg-tg-section-bg text-sm font-medium flex items-center justify-between px-4 active:scale-[0.99] transition-transform">
          <span>{showExtras ? 'Скрыть доп. инфо' : 'Доп. инфо'}</span>
          <span className={`transition-transform ${showExtras ? 'rotate-180' : ''}`}>▾</span>
        </button>

        {showExtras && (
          <div className="space-y-3">
            <Card>
              <Label icon="🏫">Учебное заведение</Label>
              <Combo value={school} onChange={setSchool} options={schema.schools} placeholder="Не выбрано" allowEmpty />
            </Card>
            <Card>
              <Label icon="📍">Адрес</Label>
              <Combo value={address} onChange={setAddress} options={schema.addresses} placeholder="Не выбрано" allowEmpty />
            </Card>
            <Card>
              <Label icon="🕐">Время выдачи</Label>
              <input type="time" value={time} onChange={e => setTime(e.target.value)}
                className="w-full bg-tg-secondary-bg rounded-xl px-3 py-2.5 outline-none" />
            </Card>
            <div className="grid grid-cols-2 gap-3">
              <Card>
                <Label icon="💵">Цена за шт</Label>
                <NumberInput value={priceStr} onChange={setPriceStr} placeholder={String(autoPrice || 0)} />
              </Card>
              <Card>
                <Label icon="💰">Оплачено</Label>
                <NumberInput value={paidStr} onChange={setPaidStr} placeholder="0" />
              </Card>
            </div>
            <Card>
              <Label icon="🏷">Скидка</Label>
              <NumberInput value={discountStr} onChange={setDiscountStr} placeholder="0" />
            </Card>
            <Card>
              <Label icon="💬">Примечание</Label>
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
                placeholder="Любые заметки..."
                className="w-full bg-tg-secondary-bg rounded-xl px-3 py-2.5 resize-none outline-none placeholder:text-tg-hint/60" />
            </Card>
          </div>
        )}

        {submitError && (
          <div className="bg-tg-destructive/10 text-tg-destructive rounded-xl p-3 text-sm">
            {submitError}
          </div>
        )}
      </div>

      {/* Sticky submit */}
      <div className="fixed bottom-0 inset-x-0 p-4 bg-gradient-to-t from-tg-bg via-tg-bg to-transparent pt-6">
        <div className="max-w-md mx-auto">
          <button onClick={submit} disabled={!valid || submitting}
            className={`w-full py-4 rounded-2xl font-semibold text-base shadow-lg transition-all ${valid && !submitting
              ? 'bg-tg-button text-tg-button-text active:scale-[0.98]'
              : 'bg-tg-secondary-bg text-tg-hint cursor-not-allowed'}`}>
            {submitting ? 'Создаю…' : valid ? '✓ Создать клиента' : 'Заполни обязательные поля'}
          </button>
        </div>
      </div>

      {showPosModal && (
        <PositionModal schema={schema}
          onAdd={(p) => { setPositions([...positions, p]); setShowPosModal(false); }}
          onClose={() => setShowPosModal(false)} />
      )}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="bg-tg-section-bg rounded-2xl p-4 shadow-sm">{children}</div>;
}

function Label({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm font-medium text-tg-hint mb-2">
      <span>{icon}</span>
      <span>{children}</span>
    </div>
  );
}

function Chip({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-all ${active
        ? 'bg-tg-button text-tg-button-text shadow-sm'
        : 'bg-tg-secondary-bg text-tg-text active:scale-95'}`}>
      {children}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs opacity-70">{label}</div>
      <div className="font-semibold">{value} ₸</div>
    </div>
  );
}

function NumberInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <input type="number" inputMode="decimal" value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        className="flex-1 min-w-0 bg-tg-secondary-bg rounded-xl px-3 py-2.5 outline-none placeholder:text-tg-hint/60" />
      <span className="text-tg-hint text-sm">₸</span>
    </div>
  );
}

function PositionRow({ p, onDelete }: { p: DraftPosition; onDelete: () => void }) {
  const emoji = p.color.split(/\s/)[0];
  const colorName = p.color.split(/\s/).slice(1).join(' ');
  return (
    <div className="flex items-center gap-3 bg-tg-secondary-bg rounded-xl p-3">
      <div className="text-2xl">{emoji}</div>
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{colorName} {p.size} · {p.kind}</div>
        <div className="text-xs text-tg-hint">×{p.qty} шт</div>
      </div>
      <button onClick={onDelete}
        className="w-8 h-8 rounded-full bg-tg-destructive/10 text-tg-destructive flex items-center justify-center text-lg active:scale-90 transition-transform">
        ×
      </button>
    </div>
  );
}

function Combo({
  value, onChange, options, placeholder, allowEmpty,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  allowEmpty?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const filtered = useMemo(() => {
    if (!query) return options;
    const q = query.toLowerCase();
    return options.filter(o => o.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)}
        className="w-full bg-tg-secondary-bg rounded-xl px-3 py-2.5 text-left flex items-center justify-between active:scale-[0.99] transition-transform">
        <span className={value ? 'truncate' : 'text-tg-hint/70'}>{value || placeholder}</span>
        <span className={`text-tg-hint text-xs transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>
      {open && (
        <div className="absolute z-30 left-0 right-0 mt-1.5 bg-tg-section-bg border border-tg-hint/15 rounded-xl shadow-xl max-h-72 overflow-auto">
          <div className="sticky top-0 bg-tg-section-bg p-2">
            <input autoFocus value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Поиск..."
              className="w-full px-3 py-2 bg-tg-secondary-bg rounded-lg outline-none text-sm" />
          </div>
          {allowEmpty && (
            <button onClick={() => { onChange(''); setOpen(false); setQuery(''); }}
              className="w-full text-left px-3 py-2.5 hover:bg-tg-secondary-bg/50 text-tg-hint text-sm border-t border-tg-hint/10">
              — Не выбрано —
            </button>
          )}
          {filtered.map(o => (
            <button key={o} onClick={() => { onChange(o); setOpen(false); setQuery(''); }}
              className={`w-full text-left px-3 py-2.5 hover:bg-tg-secondary-bg/50 text-sm ${o === value ? 'text-tg-link font-medium bg-tg-button/5' : ''}`}>
              {o}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="px-3 py-4 text-tg-hint text-sm text-center">Ничего не найдено</div>
          )}
        </div>
      )}
    </div>
  );
}
