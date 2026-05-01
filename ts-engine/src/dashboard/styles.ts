export const dashboardStyles = `
  :root {
    color-scheme: light;
    --paper: #fffaf0;
    --paper-strong: #fff3d4;
    --ink: #24201a;
    --muted: #746b5d;
    --line: #e4d8c1;
    --accent: #9a4f1f;
    --accent-soft: #f7d5ad;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    min-height: 100vh;
    color: var(--ink);
    font-family: "Avenir Next", "Gill Sans", "Trebuchet MS", sans-serif;
    background:
      radial-gradient(circle at 10% 0%, rgba(154, 79, 31, 0.18), transparent 34rem),
      linear-gradient(135deg, #fffaf0 0%, #f8efe0 54%, #f0dcc2 100%);
  }

  main {
    width: min(1120px, calc(100vw - 32px));
    margin: 0 auto;
    padding: 40px 0 56px;
  }

  header {
    margin-bottom: 24px;
    padding: 24px;
    border: 1px solid var(--line);
    border-radius: 24px;
    background: rgba(255, 250, 240, 0.82);
    box-shadow: 0 24px 60px rgba(83, 57, 25, 0.12);
  }

  h1 {
    margin: 0 0 8px;
    font-size: clamp(2rem, 4vw, 4rem);
    letter-spacing: -0.06em;
    line-height: 0.92;
  }

  h2 {
    margin: 0 0 14px;
    font-size: 1.05rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .meta,
  .empty,
  .control-note {
    color: var(--muted);
    font-size: 0.9rem;
  }

  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 18px;
  }

  .pill {
    display: inline-flex;
    gap: 6px;
    align-items: baseline;
    padding: 8px 12px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--paper-strong);
    font-size: 0.9rem;
  }

  .pill strong { font-size: 1rem; }

  section {
    margin-top: 18px;
    padding: 18px;
    border: 1px solid var(--line);
    border-radius: 18px;
    background: rgba(255, 250, 240, 0.9);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    overflow: hidden;
    border-radius: 14px;
  }

  th,
  td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
    text-align: left;
    font-size: 0.9rem;
    vertical-align: top;
  }

  th {
    color: var(--muted);
    background: rgba(247, 213, 173, 0.46);
    font-size: 0.76rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  tr:last-child td { border-bottom: 0; }

  a { color: var(--accent); }

  code {
    padding: 2px 5px;
    border-radius: 6px;
    background: var(--accent-soft);
  }

  @media (max-width: 720px) {
    main { width: min(100vw - 20px, 1120px); padding-top: 18px; }
    header, section { padding: 16px; border-radius: 16px; }
    table { display: block; overflow-x: auto; }
  }
`;
