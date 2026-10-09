// DEV-ONLY component gallery (vite dev server: /dev/gallery.html). Not part of the production build
// (vite builds index.html only). Sample strings are typesetting examples from spec §21, not medical content.
import { StrictMode, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Bold, Copy, Ellipsis, Highlighter, Italic, PenLine, Trash2, Underline, BookOpen, FileText } from 'lucide-react';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/noto-naskh-arabic/400.css';
import '@fontsource/noto-naskh-arabic/600.css';
import '../src/design/tokens.css';
import '../src/design/base.css';
import '../src/design/components.css';
import '../src/app/shell.css';
import './gallery.css';
import { richTextFromPlain } from '@medlevo/shared';
import {
  Bidi,
  Breadcrumbs,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  IconButton,
  Kbd,
  ListItem,
  LoadingState,
  Menu,
  MenuItem,
  MenuSeparator,
  PasswordField,
  ProgressBar,
  RichTextView,
  SaveStatus,
  SegmentedControl,
  Select,
  Sheet,
  Skeleton,
  SourceChip,
  StatusPill,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextArea,
  TextField,
  ThemeProvider,
  ToastProvider,
  Toolbar,
  Tooltip,
  useResizablePanel,
  useToast,
} from '../src/design';

const SAMPLE = richTextFromPlain(
  [
    'الجرعة المكتوبة في المثال: 5 mg IV مرتين يوميًا.',
    'القيمة pH 7.35 والقيمة Na+ 135 mmol/L داخل جملة عربية.',
    'بكتيريا H. pylori وفحص CT abdomen والمسار A → B → C.',
  ].join('\n'),
);

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="ml-gallery__section">
      <h2 className="ml-settings__section-title">{title}</h2>
      <div className="ml-group ml-group__row ml-group__row--stack">{children}</div>
    </section>
  );
}

function Gallery() {
  const toast = useToast();
  const [tab, setTab] = useState('a');
  const [seg, setSeg] = useState('normal');
  const [sw, setSw] = useState(true);
  const [cb, setCb] = useState(false);
  const [sel, setSel] = useState('medium');
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [sheet, setSheet] = useState(false);
  const rail = useResizablePanel({ initial: 300, min: 220, max: 480, side: 'start' });
  return (
    <div className="ml-page">
      <header className="ml-page__header">
        <Breadcrumbs items={[{ label: 'المكتبة', to: '/library' }, { label: 'الجراحة', to: '/library/s' }, { label: 'معرض المكونات' }]} />
        <h1 className="ml-page__title">معرض مكونات التصميم</h1>
        <p className="ml-page__lede">صفحة تطوير فقط للتحقق البصري من المكونات.</p>
      </header>
      <div className="ml-gallery">
        <Section title="الأزرار">
          <div className="ml-cluster">
            <Button variant="primary">حفظ</Button>
            <Button>إلغاء</Button>
            <Button variant="plain">تفاصيل</Button>
            <Button variant="destructive" icon={<Trash2 size={16} />}>
              حذف نهائي
            </Button>
            <Button variant="primary" loading loadingLabel="جارٍ الحفظ…">
              حفظ
            </Button>
            <Button disabled>غير متاح</Button>
          </div>
          <div className="ml-cluster">
            <Button size="sm">صغير</Button>
            <Button size="md">متوسط</Button>
            <Button size="lg" variant="primary">
              كبير
            </Button>
            <IconButton label="نسخ" icon={<Copy size={20} />} />
            <IconButton label="قلم" icon={<PenLine size={20} />} pressed />
            <Tooltip content="يظهر عند التركيز بلوحة المفاتيح أو الضغط المطوّل">
              <Button size="sm">تلميح</Button>
            </Tooltip>
            <Kbd>Ctrl</Kbd> <Kbd>K</Kbd>
          </div>
        </Section>

        <Section title="الحقول">
          <TextField label="عنوان الدفتر" hint="يظهر في المكتبة." placeholder="مثل: الجراحة العامة" />
          <TextField label="اسم المستخدم" error="من 3 إلى 64 حرفًا." defaultValue="ab" />
          <PasswordField label="كلمة المرور" />
          <Select
            label="مستوى الشرح"
            value={sel}
            onValueChange={setSel}
            options={[
              { value: 'simple', label: 'مبسّط' },
              { value: 'medium', label: 'متوسط' },
              { value: 'detailed', label: 'مفصّل' },
            ]}
          />
          <TextArea label="ملاحظة" rows={2} />
          <Switch label="ملمس الورق" description="ملمس خفيف لا يغيّر التباين." checked={sw} onCheckedChange={setSw} />
          <Checkbox label="حفظت الرموز في مكان آمن" checked={cb} onCheckedChange={setCb} />
          <SegmentedControl
            label="كثافة الهامش"
            showLabel
            value={seg}
            onValueChange={setSeg}
            options={[
              { value: 'minimal', label: 'بسيطة' },
              { value: 'normal', label: 'عادية' },
              { value: 'rich', label: 'غنية' },
            ]}
          />
        </Section>

        <Section title="التبويبات والقوائم وشريط الأدوات">
          <Tabs value={tab} onValueChange={setTab}>
            <TabList label="عرض المصدر">
              <Tab value="a" icon={<FileText size={16} />}>
                المحاضرة الأصلية
              </Tab>
              <Tab value="b" icon={<BookOpen size={16} />}>
                Study Book
              </Tab>
              <Tab value="c" disabled>
                تقسيم
              </Tab>
            </TabList>
            <TabPanel value="a">محتوى المحاضرة.</TabPanel>
            <TabPanel value="b">محتوى الكتاب الدراسي.</TabPanel>
          </Tabs>
          <div className="ml-cluster">
            <Menu trigger={<IconButton label="خيارات المصدر" icon={<Ellipsis size={20} />} />}>
              <MenuItem icon={<Copy size={16} />} onSelect={() => toast.show({ tone: 'success', title: 'نُسخ الرابط' })} hint="Ctrl C">
                نسخ الرابط
              </MenuItem>
              <MenuItem onSelect={() => {}} disabled disabledReason="يحتاج اتصالًا">
                تنزيل للعمل دون اتصال
              </MenuItem>
              <MenuSeparator />
              <MenuItem destructive icon={<Trash2 size={16} />} onSelect={() => setConfirm(true)}>
                نقل إلى سلة المحذوفات
              </MenuItem>
            </Menu>
            <Toolbar label="أدوات الكتابة">
              <IconButton label="عريض" icon={<Bold size={18} />} />
              <IconButton label="مائل" icon={<Italic size={18} />} />
              <IconButton label="تسطير" icon={<Underline size={18} />} />
              <IconButton label="تظليل" icon={<Highlighter size={18} />} pressed />
            </Toolbar>
          </div>
        </Section>

        <Section title="الحالة والمصادر">
          <div className="ml-cluster">
            <StatusPill tone="success">مرتبط بدليل</StatusPill>
            <StatusPill tone="warning">يحتاج مراجعة</StatusPill>
            <StatusPill tone="danger">مرفوض</StatusPill>
            <StatusPill tone="info">قيد التحقق</StatusPill>
            <StatusPill tone="accent" icon={false}>
              مولّد
            </StatusPill>
          </div>
          <div className="ml-cluster">
            <SaveStatus state="saved_locally" />
            <SaveStatus state="pending_sync" />
            <SaveStatus state="synced" />
            <SaveStatus state="conflict" />
            <SaveStatus state="error" detail="رفض الخادم التغيير" />
          </div>
          <p>
            يذكر المصدر ذلك صراحة <SourceChip label="محاضرة" page="12" pageIndex={13} sourceTitle="Appendicitis" onOpen={() => {}} /> ويؤكده المرجع{' '}
            <SourceChip label="مرجع" page="88" pageIndex={87} onOpen={() => {}} available={false} />.
          </p>
        </Section>

        <Section title="التحميل والفراغ والأخطاء">
          <Skeleton lines={3} />
          <LoadingState stage="استخراج النص" done={12} total={40} unit="صفحة" inline />
          <LoadingState stage="التعرّف الضوئي على الحروف" done={3} unit="صفحة" inline />
          <ProgressBar label="رفع الملف" />
          <ErrorState inline title="تعذّرت معالجة الصفحة 7" message="الصورة غير مقروءة. بقية الصفحات جاهزة للقراءة." onRetry={() => {}} />
          <EmptyState icon={<BookOpen size={28} />} title="لا توجد مصادر بعد" description="ارفع أول محاضرة لتبدأ." actions={<Button variant="primary">رفع ملف</Button>} headingLevel={3} />
        </Section>

        <Section title={<>النص المختلط (<Bidi dir="ltr">§21</Bidi>)</>}>
          <RichTextView value={SAMPLE} variant="reading" />
        </Section>

        <Section title="القوائم والحوارات">
          <ul className="ml-list" role="list">
            <ListItem title="الجراحة العامة" subtitle="12 محاضرة" leading={<BookOpen size={20} />} to="/library/a" trailing={<StatusPill tone="success">جاهز</StatusPill>} />
            <ListItem title="الباطنية" subtitle="قيد المعالجة" leading={<BookOpen size={20} />} onClick={() => {}} />
          </ul>
          <div className="ml-cluster">
            <Button onClick={() => setDialog(true)}>حوار</Button>
            <Button onClick={() => setConfirm(true)}>تأكيد إجراء مدمّر</Button>
            <Button onClick={() => setSheet(true)}>لوحة جانبية</Button>
            <Button onClick={() => toast.show({ tone: 'danger', title: 'تعذّر الحفظ على الخادم', description: 'التغيير محفوظ على هذا الجهاز.' })}>إشعار خطأ</Button>
          </div>
          <div className="ml-gallery__rail">
            <div style={{ width: rail.width }} className="ml-gallery__rail-panel">
              لوحة قابلة لتغيير العرض: {rail.width}px
            </div>
            <div {...rail.handleProps()} />
            <div className="ml-gallery__rail-book">مساحة الكتاب</div>
          </div>
        </Section>
      </div>
      <Dialog open={dialog} onClose={() => setDialog(false)} title="إعادة تسمية الدفتر" footer={<Button variant="primary" onClick={() => setDialog(false)}>حفظ</Button>}>
        <TextField label="الاسم الجديد" defaultValue="الجراحة" />
      </Dialog>
      <ConfirmDialog
        open={confirm}
        title="حذف المحاضرة نهائيًا؟"
        impact="ستُحذف المحاضرة وصفحاتها. الملاحظات والحبر المرتبطان بها يبقيان في «تحتاج إعادة ربط»."
        confirmLabel="حذف نهائي"
        destructive
        requireText="Appendicitis"
        onConfirm={() => setConfirm(false)}
        onCancel={() => setConfirm(false)}
      />
      <Sheet open={sheet} onClose={() => setSheet(false)} title="لوحة الدراسة" footer={<Button onClick={() => setSheet(false)}>إغلاق</Button>}>
        <p>محتوى اللوحة: الشرح السياقي، المصادر، الأسئلة.</p>
      </Sheet>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <MemoryRouter>
          <Gallery />
        </MemoryRouter>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
