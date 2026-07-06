import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide67Tokens = contentTokens["slide-67"];

export function buildSlide67(presentation, tokens = slide67Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-67", width: "fill", height: "fill" }, [
      text([tokens.body1.paragraph01, tokens.body1.titleHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing, tokens.body1.detailGoesHere, tokens.body1.detailGoesHere2, tokens.body1.detailGoesHere3], {
        name: "Google-Shape-534-p58",
        ...frame({ left: "41px", top: "251px", width: "375px", height: "378px" }),
        style: textStyles.helveticaNeueFont32TopColorTx1,
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.body2.paragraph02, tokens.body2.titleHere, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing, tokens.body2.detailGoesHere, tokens.body2.detailGoesHere2, tokens.body2.detailGoesHere3], {
        name: "Content-Placeholder-1",
        ...frame({ left: "453px", top: "249px", width: "375px", height: "380px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body3.paragraph03, tokens.body3.titleHere, tokens.body3.loremIpsumDolorSitAmetConsecteturAdipiscing, tokens.body3.detailGoesHere, tokens.body3.detailGoesHere2, tokens.body3.detailGoesHere3], {
        name: "Content-Placeholder-2",
        ...frame({ left: "864px", top: "249px", width: "375px", height: "380px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "1197px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
