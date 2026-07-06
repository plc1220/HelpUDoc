import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide47Tokens = contentTokens["slide-47"];

export function buildSlide47(presentation, tokens = slide47Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-47", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "583px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-6",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "658px", top: "249px", width: "581px", height: "172px" }),
      }),
      text([tokens.body2.titleGoesHere, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-10",
        ...frame({ left: "689px", top: "280px", width: "524px", height: "110px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx12,
      }),
      shape({
        name: "Rounded-Rectangle-8",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "658px", top: "41px", width: "581px", height: "172px" }),
      }),
      text([tokens.body1.titleGoesHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-10",
        ...frame({ left: "689px", top: "72px", width: "524px", height: "110px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx12,
      }),
      shape({
        name: "Rounded-Rectangle-1",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "658px", top: "460px", width: "581px", height: "172px" }),
      }),
      text([tokens.body3.titleGoesHere, tokens.body3.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-10",
        ...frame({ left: "689px", top: "491px", width: "524px", height: "110px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx12,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
