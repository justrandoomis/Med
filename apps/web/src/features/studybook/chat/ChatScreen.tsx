// /chat[?thread=] — every saved study conversation (ChatGPT-like history grouped by day, search, rename, delete) and the
// chat itself to continue any of them. A new conversation starts from a lecture (its pages are the evidence), so here
// the composer continues saved conversations; a «ص N» chip opens that page of the conversation's lecture.
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useCapabilities } from '../../../lib/capabilities';
import { AiAllowanceNote } from '../../../lib/aiAllowance';
import { useOnline } from '../../../lib/useOnline';
import { usePageTitle } from '../../../lib/usePageTitle';
import { ChatSurface } from './ChatSurface';

export function ChatScreen() {
  usePageTitle('المحادثات الدراسية');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const online = useOnline();
  const gate = useCapabilities().feature('ai.chat');
  return (
    <div className="ml-page">
      <header className="ml-page__header">
        <h1 className="ml-page__title">المحادثات الدراسية</h1>
        <p className="ml-page__lede">محادثاتك المحفوظة مع مصادرك. ابدأ محادثة جديدة من صفحة أي محاضرة لتُبنى إجاباتها منها.</p>
      </header>
      <AiAllowanceNote />
      <ChatSurface
        layout="full"
        sourceId={null}
        scope={null}
        gate={gate}
        online={online}
        initialThreadId={params.get('thread')}
        onOpenSourcePage={(sourceId, pageIndex) => navigate(`/study/${encodeURIComponent(sourceId)}?page=${pageIndex}`)}
      />
    </div>
  );
}
