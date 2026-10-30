export default function AppShell({ sidebar, main, panel }) {
  return (
    <div className="shell">
      <aside className="shell-sidebar">{sidebar}</aside>
      <section className="shell-main">{main}</section>
      <aside className="shell-panel">{panel}</aside>
    </div>
  );
}