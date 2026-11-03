import snJnlClass from '../assets/templates/springer/sn-jnl.cls?raw';
import snMathPhysNum from '../assets/templates/springer/sn-mathphys-num.bst?raw';
import snSource from '../assets/templates/springer/SOURCE.txt?raw';

export type TemplateAsset = { name: string; content: string };
export type TemplateStarter = { id: string; name: string; description: string; source: string; files?: TemplateAsset[] };

export const templateStarters: TemplateStarter[] = [
  { id: 'ieee-template', name: 'IEEE conference', description: 'Complete IEEE conference-paper outline with citations and references.', source: String.raw`\documentclass[conference]{IEEEtran}
\usepackage{cite}
\usepackage{amsmath,amssymb}
\title{Your IEEE Conference Paper Title}
\author{\IEEEauthorblockN{First Author}
\IEEEauthorblockA{Department, University\\
City, Country\\
author@example.com}}
\begin{document}
\maketitle
\begin{abstract}
Summarize the problem, approach, main results, and contribution in a concise paragraph.
\end{abstract}
\begin{IEEEkeywords}
keyword one, keyword two, keyword three
\end{IEEEkeywords}
\section{Introduction}\label{sec:introduction}
Introduce the problem, explain its importance, and state the contributions. Prior work provides useful context~\cite{einstein1905}.
\section{Related Work}\label{sec:related-work}
Summarize the most relevant literature and explain how this paper differs.
\section{Methodology}\label{sec:methodology}
Describe the study design, data, and analysis so the work can be reproduced.
\subsection{Data Collection}\label{subsec:data}
Describe the data sources, inclusion criteria, and collection procedure.
\subsubsection{Preprocessing}
Explain the preparation steps applied before analysis.
\subsection{Analysis}\label{subsec:analysis}
State the model or method. For example, the linear relation is
\begin{equation}
  y = mx + b.
\end{equation}
\section{Results}\label{sec:results}
Report the findings with appropriate tables or figures.
\section{Discussion}\label{sec:discussion}
Interpret the findings, limitations, and implications.
\section{Conclusion}\label{sec:conclusion}
Summarize the contribution and describe useful future work.
\section*{Acknowledgment}
Thank contributors and funding sources here.
\bibliographystyle{IEEEtran}
\bibliography{references}
\end{document}
`, files: [
    { name: 'references.bib', content: String.raw`@article{einstein1905,
  author = {Einstein, Albert},
  title = {On the Electrodynamics of Moving Bodies},
  journal = {Annalen der Physik},
  year = {1905}
}
` },
  ] },
  { id: 'springer-template', name: 'Springer', description: 'Springer Nature journal manuscript with the official sn-jnl class.', source: String.raw`\documentclass[pdflatex,sn-mathphys-num]{sn-jnl}
\usepackage{graphicx}
\usepackage{amsmath,amssymb}
\begin{document}
\title[Short title]{Your Article Title}
\author*[1]{\fnm{First} \sur{Author}}\email{author@example.com}
\affil*[1]{\orgname{Your Institution}, \orgaddress{\city{Your City}, \country{Your Country}}}
\abstract{Write a concise summary of your research, methods, and principal findings.}
\keywords{keyword one, keyword two, keyword three}
\maketitle
\section{Introduction}\label{sec:intro}
Introduce the research question and relevant background. Example citation~\cite{einstein1905}.
\section{Results}\label{sec:results}
Present the main findings. For example, the relationship is described by
\begin{equation}
  y = mx + b.
\end{equation}
\section{Methods}\label{sec:methods}
Describe the study design, data, and analysis so the work can be reproduced.
\subsection{Data Collection}\label{subsec:data}
Describe the data sources, inclusion criteria, and collection procedure.
\subsubsection{Preprocessing}
Explain the preparation steps applied before analysis.
\subsection{Analysis}\label{subsec:analysis}
State the model or method used to reach the reported results.
\section{Discussion}\label{sec:discussion}
Explain the findings and their limitations.
\section{Conclusion}\label{sec:conclusion}
Summarize the main contribution.
\backmatter
\bmhead{Acknowledgements}
Thank contributors and funding sources here.
\bibliography{references}
\end{document}
`, files: [
    { name: 'sn-jnl.cls', content: snJnlClass },
    { name: 'sn-mathphys-num.bst', content: snMathPhysNum },
    { name: 'SOURCE.txt', content: snSource },
    { name: 'references.bib', content: String.raw`@article{einstein1905,
  author = {Einstein, Albert},
  title = {On the Electrodynamics of Moving Bodies},
  journal = {Annalen der Physik},
  year = {1905}
}
` },
  ] },
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
