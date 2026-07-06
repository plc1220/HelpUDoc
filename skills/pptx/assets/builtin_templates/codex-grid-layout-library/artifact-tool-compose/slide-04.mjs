import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide04Tokens = contentTokens["slide-04"];

export function buildSlide04(presentation, tokens = slide04Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-04", width: "fill", height: "fill" }, [
      image({
        name: "Picture-15",
        prompt: "dominant hero visual matching this template's visual system; subject or semantic cue: Picture 15; palette cues: tx1; image treatment: crop left 5.958%, top 0%, right 0%, bottom 26.52%; no embedded text, preserve generous crop room for slide overlays",
        alt: "hero placeholder for Picture 15",
        fit: "cover",
        crop: {"left":0.05958,"top":0,"right":0,"bottom":0.2652},
        ...frame({ left: "828px", top: "41px", width: "410px", height: "640px" }),
      }),
      text([tokens.title3], {
        name: "Title-3",
        ...frame({ left: "41px", top: "183px", width: "616px", height: "262px" }),
        style: textStyles.helveticaNeueFont80BottomColorTx1,
      }),
      text([tokens.title4.loremIpsumDetails, tokens.title4.loremIpsumDetails2], {
        name: "Subtitle-4",
        ...frame({ left: "41px", top: "561px", width: "375px", height: "69px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.title], {
        name: "Subtitle-4",
        ...frame({ left: "41px", top: "41px", width: "376px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.title2], {
        name: "Subtitle-4",
        ...frame({ left: "452px", top: "41px", width: "205px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
