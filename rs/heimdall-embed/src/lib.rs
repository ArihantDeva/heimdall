use std::path::Path;

use ort::session::Session;
use tokenizers::tokenizer::{Encoding, Tokenizer};

pub const MODEL_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/model");
const MAX_LEN: usize = 512;

/// Mean-pool over non-pad tokens (bge uses CLS pooling, but for ranking
/// similarity any consistent pooling works; here we mean-pool to stay
/// dependency-free and match bge's default sentence-transformers pooling
/// which is 'mean' for bge-small).
fn mean_pool(last_hidden: &ndarray::Array2<f32>, attn: &[i64]) -> Vec<f32> {
    let (n, dim) = last_hidden.dim();
    let mut pooled = vec![0f32; dim];
    let mut count = 0usize;
    for i in 0..n {
        if attn.get(i).copied().unwrap_or(0) != 0 {
            for d in 0..dim {
                pooled[d] += last_hidden[[i, d]];
            }
            count += 1;
        }
    }
    if count > 0 {
        for d in 0..dim {
            pooled[d] /= count as f32;
        }
    }
    pooled
}

fn normalize(v: &mut [f32]) {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

pub struct Embedder {
    session: Session,
    tokenizer: Tokenizer,
}

impl Embedder {
    pub fn new(model_dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let session = Session::builder()?.commit_from_file(model_dir.join("model.onnx"))?;
        let tokenizer = Tokenizer::from_file(model_dir.join("tokenizer.json"))
            .map_err(|e| format!("tokenizer load: {e}"))?;
        Ok(Self { session, tokenizer })
    }

    pub fn encode(&mut self, text: &str) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let enc: Encoding = self
            .tokenizer
            .encode(text, true)
            .map_err(|e| format!("encode: {e}"))?;
        let ids: Vec<i64> = enc.get_ids().iter().map(|&x| x as i64).collect();
        let attn: Vec<i64> = enc.get_attention_mask().iter().map(|&x| x as i64).collect();
        let len = ids.len().min(MAX_LEN);
        let ids: Vec<i64> = ids[..len].to_vec();
        let attn: Vec<i64> = attn[..len].to_vec();

        let input_ids = ort::value::Value::from_array(
            ndarray::Array2::from_shape_vec((1, len), ids)?,
        )?;
        let attn_arr = ndarray::Array2::from_shape_vec(
            (1, len),
            attn.iter().map(|&x| x as i64).collect(),
        )?;
        let attention_mask = ort::value::Value::from_array(attn_arr)?;
        let token_type = ort::value::Value::from_array(
            ndarray::Array2::<i64>::zeros((1, len)),
        )?;

        let outputs = self.session.run(ort::inputs![input_ids, attention_mask, token_type])?;
        let last_hidden = outputs[0].try_extract_tensor::<f32>()?;
        let (shape, data) = last_hidden;
        // last_hidden_state is (1, seq_len, hidden) — take the single batch row.
        let (seq, dim) = (shape[1] as usize, shape[2] as usize);
        let last_hidden = ndarray::Array2::from_shape_vec((seq, dim), data.to_vec())?;

        let mut vec = mean_pool(&last_hidden, &attn);
        normalize(&mut vec);
        Ok(vec)
    }
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_and_cosine_smoke() {
        let mut e = Embedder::new(Path::new(MODEL_DIR)).expect("model loads");
        let a = e.encode("what degree did I graduate with").unwrap();
        let b = e.encode("I graduated with a degree in computer science").unwrap();
        let c = e.encode("the weather is nice today").unwrap();
        // related pair ranks above unrelated pair
        assert!(cosine(&a, &b) > cosine(&a, &c), "semantic ordering failed");
    }

    #[test]
    fn vec_is_unit_norm() {
        let mut e = Embedder::new(Path::new(MODEL_DIR)).unwrap();
        let v = e.encode("test").unwrap();
        let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((n - 1.0).abs() < 1e-3, "norm was {n}");
    }
}