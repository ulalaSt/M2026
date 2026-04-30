import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { getWebApp } from './telegram';
import type { DraftClient, DraftPosition, Schema } from './types';
import { PositionModal } from './components/PositionModal';

const MONTHS_GENITIVE = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const WEEKDAYS = ['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];

export function colorClass(color?: string): string {
  if (!color) return '';
  const c = color.toLowerCase();
  if (c.includes('зелёный') || c.includes('зеленый')) return 'green';
  if (c.includes('бордов')) return 'burgundy';
  if (c.includes('красн')) return 'red';
  if (c.includes('син')) return 'blue';
  if (c.includes('чёрн') || c.includes('черн')) return 'black';
  return '';
}

function todayIso(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
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
  if (digits.length && digits[0] === '8') digits = '7' + digits.slice(1);
  if (digits.length && digits[0] !== '7') digits = '7' + digits;
  digits = digits.slice(0, 11);
  if (digits.length === 0) return '';
  let out = '+7';
  if (digits.length > 1) out += ' ' + digits.slice(1, 4);
  if (digits.length > 4) out += ' ' + digits.slice(4, 7);
  if (digits.length > 7) out += ' ' + digits.slice(7, 9);
  if (digits.length > 9) out += ' ' + digits.slice(9, 11);
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
  const remaining = Math.max(0, sum - paid - discount);
  const phoneNormalized = useMemo(() => normalizePhone(phone), [phone]);
  const valid = !!phoneNormalized && !!date && positions.length > 0;

  const dateObj = useMemo(() => new Date(date + 'T00:00:00'), [date]);
  const dayMeta = useMemo(() => {
    const today = new Date(); today.setHours(0,0,0,0);
    const dd = new Date(dateObj); dd.setHours(0,0,0,0);
    const diff = Math.round((dd.getTime() - today.getTime()) / 86400000);
    if (diff === 0) return 'сегодня';
    if (diff === 1) return 'завтра';
    if (diff > 0) return `через ${diff} дн.`;
    return `${Math.abs(diff)} дн. назад`;
  }, [dateObj]);

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
      <div className="app">
        <div className="card" style={{ marginTop: 80 }}>
          <div className="card-title" style={{ color: 'var(--danger)' }}>Ошибка загрузки</div>
          <div style={{ marginTop: 12, fontSize: 14, color: 'var(--ink-2)' }}>{loadError}</div>
        </div>
      </div>
    );
  }
  if (!schema) {
    return (
      <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <div style={{ color: 'var(--ink-3)', fontFamily: 'Fraunces, serif', fontStyle: 'italic' }}>Загрузка…</div>
      </div>
    );
  }

  const ctaText = !phoneNormalized ? 'Введите телефон'
    : positions.length === 0 ? 'Добавьте позицию'
    : submitting ? 'Создаю…'
    : `Создать заказ · ${remaining.toLocaleString('ru-RU')} ₸`;

  return (
    <>
      <div className="app">
        {/* HERO */}
        <div className="hero">
          <div className="eyebrow">Новый заказ</div>
          <h1>Создаём <em>заказ</em></h1>
          <p>Заполните данные клиента, выберите дату и позиции.</p>
        </div>

        {/* PHONE */}
        <div className="card">
          <div className="card-header">
            <div className="card-title"><span className="dot" /> Контакт клиента</div>
          </div>
          <div className="input-wrap">
            <input className="input" type="tel" inputMode="tel" placeholder="+7 ___ ___ __ __"
              value={phone}
              onChange={e => setPhone(formatPhoneInput(e.target.value))} />
            <div className="input-line" />
          </div>
        </div>

        {/* DATE */}
        <div className="card">
          <div className="card-header">
            <div className="card-title"><span className="dot" /> Дата выдачи</div>
            <div className="card-meta">{dayMeta}</div>
          </div>
          <div className="date-display">
            <div className="date-day">{dateObj.getDate()}</div>
            <div className="date-rest">
              <div className="date-month">{MONTHS_GENITIVE[dateObj.getMonth()]}</div>
              <div className="date-year">{dateObj.getFullYear()}</div>
              <div className="date-weekday">{WEEKDAYS[dateObj.getDay()]}</div>
            </div>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              className="date-input-native" />
          </div>
        </div>

        {/* POSITIONS */}
        <div className="card">
          <div className="card-header">
            <div className="card-title"><span className="dot" /> Позиции</div>
            <div className="card-meta">{positions.length === 0 ? 'не выбрано' : `всего ${totalQty} шт`}</div>
          </div>
          {positions.length === 0 ? (
            <div className="positions-empty" onClick={() => setShowPosModal(true)}>
              <div className="plus">+</div>
              <div className="label">Добавить первую позицию</div>
            </div>
          ) : (
            <>
              <div className="position-list">
                {positions.map((p, i) => (
                  <div className="position-item" key={i}>
                    <div className={`position-swatch ${colorClass(p.color)}`} />
                    <div className="position-info">
                      <div className="position-title">{stripEmoji(p.color)} · {p.size} · {p.kind}</div>
                      <div className="position-sub">×{p.qty} шт</div>
                    </div>
                    <button className="position-remove"
                      onClick={() => setPositions(positions.filter((_, j) => j !== i))}>×</button>
                  </div>
                ))}
              </div>
              <button className="add-more" onClick={() => setShowPosModal(true)}>+ ещё позиция</button>
            </>
          )}
        </div>

        {/* SUMMARY */}
        {positions.length > 0 && (
          <div className="summary">
            <div className="summary-label">К оплате</div>
            <div className="summary-total">
              {remaining.toLocaleString('ru-RU')}<span className="currency">₸</span>
            </div>
            <div className="summary-grid">
              <div className="summary-cell">
                <div className="k">Сумма</div>
                <div className="v">{sum.toLocaleString('ru-RU')} ₸</div>
              </div>
              <div className="summary-cell">
                <div className="k">Оплачено</div>
                <div className="v">{paid.toLocaleString('ru-RU')} ₸</div>
              </div>
              <div className="summary-cell">
                <div className="k">Скидка</div>
                <div className="v">{discount.toLocaleString('ru-RU')} ₸</div>
              </div>
            </div>
          </div>
        )}

        {/* TOGGLE EXTRA */}
        <button className={`toggle-extra ${showExtras ? 'open' : ''}`}
          onClick={() => setShowExtras(!showExtras)}>
          <span>Дополнительная информация</span>
          <span className="chev">⌄</span>
        </button>

        <div className={`extra-section ${showExtras ? 'open' : ''}`}>
          <div className="card">
            <div className="field-stack">
              <Combo label="Учебное заведение" placeholder="не выбрано"
                value={school} onChange={setSchool} options={schema.schools} />
              <div className="divider" />
              <Combo label="Адрес доставки" placeholder="не выбрано"
                value={address} onChange={setAddress} options={schema.addresses} />
              <div className="divider" />
              <TimeField value={time} onChange={setTime} />
            </div>
          </div>

          <div className="grid-2">
            <div className="mini-card">
              <div className="field-label">Цена за шт</div>
              <div className="input-wrap">
                <input className="input" type="number" inputMode="decimal" placeholder={String(autoPrice || 0)}
                  value={priceStr} onChange={e => setPriceStr(e.target.value)} />
                <div className="input-line" />
              </div>
            </div>
            <div className="mini-card">
              <div className="field-label">Оплачено</div>
              <div className="input-wrap">
                <input className="input" type="number" inputMode="decimal"
                  value={paidStr} onChange={e => setPaidStr(e.target.value)} />
                <div className="input-line" />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="field-label" style={{ marginBottom: 10 }}>Скидка</div>
            <div className="input-wrap">
              <input className="input" type="number" inputMode="decimal"
                value={discountStr} onChange={e => setDiscountStr(e.target.value)} />
              <div className="input-line" />
            </div>
          </div>

          <div className="card">
            <div className="field-label" style={{ marginBottom: 10 }}>Примечание</div>
            <textarea className="input" placeholder="комментарий к заказу…" rows={2}
              value={note} onChange={e => setNote(e.target.value)} />
            <div className="input-line" />
          </div>
        </div>

        {submitError && (
          <div className="card" style={{ borderColor: 'var(--danger)' }}>
            <div style={{ color: 'var(--danger)', fontSize: 13 }}>{submitError}</div>
          </div>
        )}

        <div style={{ height: 40 }} />
      </div>

      {/* CTA */}
      <div className="cta-wrap">
        <div className="cta-inner">
          <button className="cta" disabled={!valid || submitting} onClick={submit}>
            <span>{ctaText}</span>
            {valid && <span className="arrow">→</span>}
          </button>
        </div>
      </div>

      {showPosModal && (
        <PositionModal schema={schema}
          onAdd={(p) => { setPositions([...positions, p]); setShowPosModal(false); }}
          onClose={() => setShowPosModal(false)} />
      )}
    </>
  );
}

function stripEmoji(s: string): string {
  return s.replace(/^\S+\s*/, '').trim() || s;
}

function Combo({ label, value, onChange, options, placeholder }: {
  label: string; value: string; onChange: (v: string) => void;
  options: string[]; placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const filtered = useMemo(() => {
    if (!query) return options;
    const q = query.toLowerCase();
    return options.filter(o => o.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div className="field" onClick={() => setOpen(!open)}>
        <div className="field-left">
          <div className="field-label">{label}</div>
          <div className={`field-value ${value ? '' : 'placeholder'}`}>
            {value || placeholder}
          </div>
        </div>
        <div className="field-arrow" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>›</div>
      </div>
      {open && (
        <div className="combo-pop">
          <input autoFocus className="combo-search" placeholder="Поиск..."
            value={query} onChange={e => setQuery(e.target.value)} />
          <button className="combo-item empty"
            onClick={() => { onChange(''); setOpen(false); setQuery(''); }}>
            не выбрано
          </button>
          {filtered.map(o => (
            <button key={o} className={`combo-item ${o === value ? 'active' : ''}`}
              onClick={() => { onChange(o); setOpen(false); setQuery(''); }}>
              {o}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="combo-item empty">ничего не найдено</div>
          )}
        </div>
      )}
    </div>
  );
}

function TimeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div style={{ position: 'relative' }}>
      <div className="field" onClick={() => inputRef.current?.showPicker?.() ?? inputRef.current?.click()}>
        <div className="field-left">
          <div className="field-label">Время выдачи</div>
          <div className={`field-value ${value ? '' : 'placeholder'}`}>{value || 'не указано'}</div>
        </div>
        <div className="field-arrow">›</div>
      </div>
      <input ref={inputRef} type="time" value={value}
        onChange={e => onChange(e.target.value)}
        style={{ position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none' }} />
    </div>
  );
}
