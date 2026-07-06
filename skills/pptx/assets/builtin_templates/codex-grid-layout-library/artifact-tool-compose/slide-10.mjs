import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide10Tokens = contentTokens["slide-10"];

export function buildSlide10(presentation, tokens = slide10Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-10", width: "fill", height: "fill" }, [
      image({
        name: "Picture-7",
        prompt: "dominant hero visual matching this template's visual system; subject or semantic cue: Picture 7; palette cues: tx1, #000000; image treatment: crop left 0%, top 15.849%, right 4.023%, bottom 15.849%; no embedded text, preserve generous crop room for slide overlays",
        alt: "hero placeholder for Picture 7",
        fit: "cover",
        crop: {"left":0,"top":0.15849,"right":0.04023,"bottom":0.15849},
        ...frame({ left: "774px", top: "3px", width: "506px", height: "720px" }),
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Slide-Number-Placeholder-1",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15BottomRightColorTx1,
      }),
      text([tokens.title], {
        name: "Title-2",
        ...frame({ left: "41px", top: "36px", width: "411px", height: "73px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.title2.agendaItemOne, tokens.title2.agendaItemTwo, tokens.title2.agendaItemThree, tokens.title2.agendaItemFour, tokens.title2.agendaItemFive, tokens.title2.agendaItemSix], {
        name: "Title-2",
        ...frame({ left: "41px", top: "213px", width: "581px", height: "416px" }),
        style: textStyles.helveticaNeueFont39TopColor000000,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
