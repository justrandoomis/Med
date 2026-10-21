// «وضع العرض على هذا الجهاز» in Settings → المظهر (Academic OS P1-T2 step 2; ADR-0005 B.4; PRD AOS-4.17, OC.5).
// E-ink, high contrast and lite modes belong to the screen in hand, so they are kept on this device only. E-ink is
// suggested only when the browser itself reports a slowly updating screen (`(update: slow)`); otherwise the owner picks.
import { useSyncExternalStore } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { Button, Switch } from '../../design';
import { DEFAULT_DISPLAY, displayStore, screenUpdatesSlowly, shouldSuggestEink } from '../../design/themeDisplay';

export function DisplayModeRows() {
  const prefs = useSyncExternalStore(displayStore.subscribe, displayStore.get, () => DEFAULT_DISPLAY);
  const suggest = shouldSuggestEink(prefs, screenUpdatesSlowly());
  return (
    <>
      <div className="ml-group__row ml-group__row--stack">
        <p className="ml-settings__subhead" id="display-mode-h">
          <MonitorSmartphone size={16} aria-hidden="true" /> وضع العرض على هذا الجهاز
        </p>
        <p className="ml-settings__help">يُحفظ على هذا الجهاز فقط، فلكل شاشة ما يناسبها، ولا يغيّر إعداداتك على أجهزتك الأخرى.</p>
        {suggest && (
          <div className="ml-settings__note" role="status">
            <span>يبدو أن شاشة هذا الجهاز تُحدَّث ببطء (كما في شاشات الحبر الإلكتروني). هل تريد تشغيل وضع الحبر الإلكتروني؟</span>
            <span className="ml-settings__note-actions">
              <Button size="sm" variant="primary" onClick={() => displayStore.set({ eink: true })}>
                شغّله
              </Button>
              <Button size="sm" variant="plain" onClick={() => displayStore.set({ eink_suggestion_dismissed: true })}>
                لا، شكرًا
              </Button>
            </span>
          </div>
        )}
      </div>
      <div className="ml-group__row">
        <Switch
          label="شاشة حبر إلكتروني (مثل BOOX)"
          description="أسود ورمادي فقط، بلا حركات ولا انتقالات، تقليب صفحات بدل التمرير الناعم، وأقل إعادة رسم أثناء الكتابة. تُستخدم الألوان الفاتحة حتى لو اخترت السمة الداكنة."
          checked={prefs.eink}
          onCheckedChange={(v) => displayStore.set({ eink: v })}
        />
      </div>
      <div className="ml-group__row">
        <Switch
          label="تباين عالٍ"
          description="نصوص ثانوية وحدود وخطوط أوضح، وبلا ملمس الورق."
          checked={prefs.contrast}
          onCheckedChange={(v) => displayStore.set({ contrast: v })}
        />
      </div>
      <div className="ml-group__row">
        <Switch
          label="وضع خفيف"
          description="للأجهزة الأبطأ: أسطح مسطّحة بلا ظلال ولا ضبابية ولا ملمس، حركات أقصر، وذاكرة أصغر لصور الكتابة المحفوظة مؤقتًا."
          checked={prefs.lite}
          onCheckedChange={(v) => displayStore.set({ lite: v })}
        />
      </div>
    </>
  );
}
