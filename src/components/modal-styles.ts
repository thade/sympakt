import { css } from 'lit';

/** Overlay scaffolding shared by the Syntakt dialogs. */
export const modalOverlayStyles = css`
  :host { display: none; }
  :host([open]) { display: block; }
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: grid;
    place-items: center;
    padding: 16px;
    background: rgba(0, 0, 0, .78);
  }
`;
