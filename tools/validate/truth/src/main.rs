// The pieces every path leaves in a set of subgraphs, read from the GBZ alone:
// each maximal run of consecutive visits of a path to nodes of one subgraph,
// with its offsets along the path. Usage:
//   gbz-truth graph.gbz queries.tsv threads > truth.tsv
// queries.tsv holds one subgraph per line, as `query<TAB>node,node,...`.
// truth.tsv holds `query<TAB>path<TAB>start<TAB>end` per piece.
use gbz::{Orientation, GBZ};
use simple_sds::serialize;

use std::collections::HashMap;
use std::env;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Instant;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        eprintln!("Usage: gbz-truth graph.gbz queries.tsv threads > truth.tsv");
        std::process::exit(1);
    }
    let threads: usize = args[3].parse().unwrap();
    let started = Instant::now();
    let graph: GBZ = serialize::load_from(&args[1]).unwrap();
    let paths = graph.metadata().map(|m| m.paths()).unwrap_or(0);
    eprintln!("Loaded {} with {} paths in {:.0} s", args[1], paths, started.elapsed().as_secs_f64());

    let mut names: Vec<String> = Vec::new();
    let mut queries_of: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut in_any = vec![0u64; graph.max_node() / 64 + 1];
    for line in BufReader::new(File::open(&args[2]).unwrap()).lines() {
        let line = line.unwrap();
        let Some((name, nodes)) = line.split_once('\t') else { continue };
        let query = names.len() as u32;
        names.push(name.to_string());
        for node in nodes.split(',').filter(|n| !n.is_empty()) {
            let id: usize = node.parse().unwrap();
            in_any[id / 64] |= 1 << (id % 64);
            queries_of.entry(id as u32).or_default().push(query);
        }
    }
    eprintln!("Read {} subgraphs over {} nodes", names.len(), queries_of.len());

    let next = AtomicUsize::new(0);
    let out = Mutex::new(BufWriter::new(std::io::stdout()));
    let pieces = AtomicUsize::new(0);
    thread::scope(|scope| {
        for _ in 0..threads.max(1) {
            scope.spawn(|| {
                let mut found: Vec<(u32, usize, usize, usize)> = Vec::new();
                // query -> start of its open run; a run stays open while
                // consecutive visits lie in the query's subgraph.
                let mut open: Vec<(u32, usize)> = Vec::new();
                loop {
                    let path = next.fetch_add(1, Ordering::Relaxed);
                    if path >= paths {
                        break;
                    }
                    let mut offset = 0;
                    open.clear();
                    if let Some(walk) = graph.path(path, Orientation::Forward) {
                        for (id, _) in walk {
                            let len = graph.sequence_len(id).unwrap();
                            let here: &[u32] = if in_any[id / 64] & (1 << (id % 64)) != 0 { &queries_of[&(id as u32)] } else { &[] };
                            open.retain(|&(query, start)| {
                                let stays = here.contains(&query);
                                if !stays {
                                    found.push((query, path, start, offset));
                                }
                                stays
                            });
                            for &query in here {
                                if !open.iter().any(|&(q, _)| q == query) {
                                    open.push((query, offset));
                                }
                            }
                            offset += len;
                        }
                    }
                    for &(query, start) in open.iter() {
                        found.push((query, path, start, offset));
                    }
                    if found.len() > 100_000 {
                        let mut out = out.lock().unwrap();
                        for &(query, path, start, end) in found.iter() {
                            writeln!(out, "{}\t{}\t{}\t{}", names[query as usize], path, start, end).unwrap();
                        }
                        pieces.fetch_add(found.len(), Ordering::Relaxed);
                        found.clear();
                    }
                }
                let mut out = out.lock().unwrap();
                for &(query, path, start, end) in found.iter() {
                    writeln!(out, "{}\t{}\t{}\t{}", names[query as usize], path, start, end).unwrap();
                }
                pieces.fetch_add(found.len(), Ordering::Relaxed);
            });
        }
    });
    out.lock().unwrap().flush().unwrap();
    eprintln!("Wrote {} pieces in {:.0} s", pieces.load(Ordering::Relaxed), started.elapsed().as_secs_f64());
}
