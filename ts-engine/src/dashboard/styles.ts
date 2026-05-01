export const dashboardStyles = `
  :root {
    color-scheme: light;
    --cream: #fffefb;
    --off-white: #fffdf9;
    --ink: #201515;
    --charcoal: #36342e;
    --muted: #939084;
    --sand: #c5c0b1;
    --light-sand: #eceae3;
    --orange: #ff4f00;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    min-height: 100vh;
    color: var(--ink);
    font-family: Inter, Helvetica, Arial, sans-serif;
    background: var(--cream);
  }

  main {
    width: min(1200px, calc(100vw - 32px));
    margin: 0 auto;
    padding: 64px 0 72px;
  }

  header {
    margin-bottom: 24px;
    padding: 32px;
    border: 1px solid var(--sand);
    border-radius: 8px;
    background: var(--off-white);
  }

  h1 {
    margin: 0 0 12px;
    font-family: "Degular Display", Inter, Helvetica, Arial, sans-serif;
    font-size: clamp(3rem, 8vw, 5rem);
    font-weight: 500;
    letter-spacing: -0.03em;
    line-height: 0.9;
  }

  h2 {
    margin: 0 0 16px;
    color: var(--charcoal);
    font-size: 0.88rem;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }

  .meta,
  .empty,
  .control-note {
    color: var(--muted);
    font-size: 0.88rem;
    font-weight: 500;
    line-height: 1.35;
  }

  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 24px;
  }

  .pill {
    display: inline-flex;
    gap: 8px;
    align-items: baseline;
    padding: 8px 16px;
    border: 1px solid var(--sand);
    border-radius: 20px;
    background: var(--cream);
    color: var(--charcoal);
    font-size: 0.88rem;
    font-weight: 500;
  }

  .pill strong {
    color: var(--ink);
    font-size: 1rem;
    font-weight: 600;
  }

  section {
    margin-top: 24px;
    padding: 24px;
    border: 1px solid var(--sand);
    border-radius: 8px;
    background: var(--cream);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid var(--sand);
    border-radius: 5px;
    overflow: hidden;
  }

  th,
  td {
    padding: 12px 16px;
    border-bottom: 1px solid var(--sand);
    color: var(--charcoal);
    text-align: left;
    font-size: 0.88rem;
    line-height: 1.25;
    vertical-align: top;
  }

  th {
    background: var(--light-sand);
    color: var(--ink);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }

  tr:last-child td { border-bottom: 0; }

  a {
    color: var(--ink);
    text-decoration: underline;
    text-decoration-color: var(--sand);
    text-decoration-thickness: 2px;
    text-underline-offset: 3px;
  }

  a:hover { text-decoration: none; }

  code {
    padding: 2px 6px;
    border: 1px solid var(--sand);
    border-radius: 4px;
    background: var(--light-sand);
    color: var(--ink);
  }

  .control-note {
    margin: 24px 0 0;
    padding-left: 16px;
    border-left: 4px solid var(--orange);
  }

  @media (max-width: 720px) {
    main {
      width: min(100vw - 20px, 1200px);
      padding: 32px 0 48px;
    }

    header,
    section {
      padding: 20px;
    }

    table {
      display: block;
      overflow-x: auto;
    }
  }
`;
