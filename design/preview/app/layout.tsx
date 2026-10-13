import "./preview.css";

export default function PreviewLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <head>
        <meta name="robots" content="noindex,nofollow" />
        <link rel="stylesheet" href="/design/project/ds/wds/tokens.css" />
        <link rel="stylesheet" href="/design/project/lop.css" />
        <link rel="stylesheet" href="/design-assets/styles/wanted-sans.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
