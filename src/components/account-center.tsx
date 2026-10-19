// Harness AccountSection geometry and Platform destinations (MIT).
import { ArrowUpRight, ArrowClockwise } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { formatBalance } from "@/lib/account-balance";
import { AccountAvatar } from "@/components/account-menu";
import { useDeepSeekAccount, type Wallet } from "@/stores/deepseek-account";
import { usePlatformPage } from "@/stores/platform-page";

const destinations = { account: "https://platform.deepseek.com/", usage: "https://platform.deepseek.com/usage", topup: "https://platform.deepseek.com/top_up" };
function PlatformLink({ page, children, primary = false }: { page: keyof typeof destinations; children: React.ReactNode; primary?: boolean }) {
  return <a className={primary ? "account-link account-primary" : "account-link"} href={destinations[page]} target="_blank" rel="noreferrer" onClick={event => {
    event.preventDefault();
    if (page !== "account") { usePlatformPage.getState().open(page === "usage" ? "usage" : "top-up"); return; }
    void openUrl(destinations[page]).catch(error => toast.error(`打开官方页面失败：${String(error)}`));
  }}>{children}</a>;
}
function Balance({ wallets, loading }: { wallets: Wallet[] | null | undefined; loading: boolean }) {
  if (wallets === null || wallets === undefined || wallets.length === 0) return <span className="account-muted">{loading ? "加载中…" : <PlatformLink page="usage">前往开放平台查看</PlatformLink>}</span>;
  return <span className="account-amount">{wallets.map(wallet => <span key={wallet.currency}>{formatBalance(wallet.balance, wallet.currency === "CNY" ? "¥" : "$")}</span>)}</span>;
}
export default function AccountCenter() {
  const { view, details, detailsLoading, detailsError, refreshDetails, start } = useDeepSeekAccount();
  if (!view.signedIn) return <section className="account-center" aria-label="个人中心"><h2 className="settings-section-title">DeepSeek 账号</h2><p className="account-muted">登录后可查看账号、用量和充值信息。</p><button type="button" className="account-link account-primary" onClick={() => void start()}>登录 DeepSeek</button></section>;
  return <section className="account-center" aria-label="个人中心">
    <div className="account-identity-card">
      <div className="account-identity"><AccountAvatar large /><div><strong>{view.name || view.contact || "已登录 DeepSeek"}</strong><span className="account-muted">{view.contact || (detailsLoading ? "加载中…" : "已通过 DeepSeek 官方授权")}</span></div></div>
      <PlatformLink page="account">更多账号信息<ArrowUpRight size={12} /></PlatformLink>
    </div>
    <div className="account-balance-card">
      <div className="account-balance-row"><span>充值余额</span><Balance wallets={details?.wallets} loading={detailsLoading} /></div>
      <div className="account-divider" />
      <div className="account-balance-row"><span>赠金余额</span><Balance wallets={details?.bonusWallets} loading={detailsLoading} /></div>
      <div className="account-divider" />
      <div className="account-balance-row"><span className="account-muted">更多</span><div className="account-links"><PlatformLink page="usage">查询用量</PlatformLink><PlatformLink page="topup" primary>充值</PlatformLink></div></div>
    </div>
    <div className="account-refresh"><span className="account-muted" role="status">{detailsError || (details && !details.profileAvailable ? "账号资料暂不可用，可重试或前往开放平台查看。" : "")}</span><button type="button" disabled={detailsLoading} onClick={() => void refreshDetails()}><ArrowClockwise size={14} />{detailsLoading ? "刷新中…" : "刷新"}</button></div>
  </section>;
}
