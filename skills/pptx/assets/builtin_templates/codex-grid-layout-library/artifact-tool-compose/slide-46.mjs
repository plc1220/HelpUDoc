import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide46Tokens = contentTokens["slide-46"];

export function buildSlide46(presentation, tokens = slide46Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-46", width: "fill", height: "fill" }, [
      shape({
        name: "Rounded-Rectangle-3",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "623px", top: "41px", width: "616px", height: "172px" }),
      }),
      shape({
        name: "Rounded-Rectangle-4",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "623px", top: "249px", width: "616px", height: "172px" }),
      }),
      shape({
        name: "Rounded-Rectangle-5",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "623px", top: "457px", width: "616px", height: "172px" }),
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Slide-Number-Placeholder-1",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15BottomRightColorTx1,
      }),
      text([tokens.title], {
        name: "Title-2",
        ...frame({ left: "41px", top: "36px", width: "517px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.body1.titleGoesHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-10",
        ...frame({ left: "657px", top: "71px", width: "555px", height: "113px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextInsetsColorTx1,
      }),
      text([tokens.body2.titleGoesHere, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-10",
        ...frame({ left: "657px", top: "280px", width: "555px", height: "110px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body3.titleGoesHere, tokens.body3.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-10",
        ...frame({ left: "657px", top: "489px", width: "555px", height: "109px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
