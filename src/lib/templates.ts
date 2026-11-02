export type TemplateStarter = { id: string; name: string; description: string; source: string };

export const templateStarters: TemplateStarter[] = [
  { id: 'ieee-template', name: 'IEEE conference', description: 'IEEE conference paper structure.', source: String.raw`\documentclass[conference]{IEEEtran}
\title{IEEE Conference Template}
\author{\IEEEauthorblockN{PaperDesk Author}}
\begin{document}
\maketitle
\section{Introduction}
This is a conference paper starter.
\end{document}
` },
  { id: 'springer-template', name: 'Springer', description: 'Springer Nature article starter.', source: String.raw`\documentclass{article}
\usepackage[margin=1in]{geometry}
\title{Springer Article Template}
\author{PaperDesk Author}
\date{}
\begin{document}
\maketitle
\section{Introduction}
This is a Springer-style article starter.
\end{document}
` },
  { id: 'article-template', name: 'Article', description: 'Standard LaTeX article.', source: String.raw`\documentclass{article}
\title{Article Template}
\author{PaperDesk Author}
\begin{document}
\maketitle
\section{Introduction}
This is an article starter.
\end{document}
` },
  { id: 'report-template', name: 'Report', description: 'Long form report structure.', source: String.raw`\documentclass{report}
\title{Report Template}
\author{PaperDesk Author}
\begin{document}
\maketitle
\chapter{Introduction}
This is a report starter.
\end{document}
` },
  { id: 'beamer-template', name: 'Beamer', description: 'Presentation slides.', source: String.raw`\documentclass{beamer}
\title{Beamer Template}
\author{PaperDesk Author}
\begin{document}
\frame{\titlepage}
\begin{frame}{Introduction}
This is a presentation starter.
\end{frame}
\end{document}
` },
  { id: 'cv-template', name: 'CV', description: 'Simple curriculum vitae.', source: String.raw`\documentclass{article}
\usepackage[margin=0.8in]{geometry}
\title{Curriculum Vitae}
\author{PaperDesk Author}
\begin{document}
\maketitle
\section*{Experience}
Add experience here.
\section*{Education}
Add education here.
\end{document}
` },
];
